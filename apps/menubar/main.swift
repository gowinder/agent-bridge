// Agent Bridge menu bar app: shows who is connected to the local bridge, and
// lets you cut a device off or revoke its credential without a terminal.
import AppKit
import CoreImage
import Foundation

struct DeviceInfo: Decodable {
    let deviceId: String
    let name: String
    let createdAt: Double
    let expiresAt: Double?
    let revokedAt: Double?
    let lastSeenAt: Double?
    let online: Bool
    /// 最近操作日志，最新的在最前面。
    let log: [String]?
}

struct ConnectionInfo: Decodable {
    let channel: String
    let kind: String
    let deviceId: String?
    let name: String?
    let since: Double
}

struct PairingInfo: Decodable {
    let channel: String
    let code: String?
    let since: Double
}

struct DevtoolsCapabilityInfo: Decodable {
    let enabled: Bool
    let expiresAt: Double?
}

/// File browsing (read-only, one project) and command execution (can write) switch separately.
struct DevtoolsInfo: Decodable {
    let files: DevtoolsCapabilityInfo?
    let terminal: DevtoolsCapabilityInfo?
}

struct Snapshot: Decodable {
    let version: String
    let hostName: String
    let roomId: String
    let webUrl: String
    let relayOnline: Bool
    let bridgePid: Int
    let devices: [DeviceInfo]
    let connections: [ConnectionInfo]
    let devtools: DevtoolsInfo?
    let pairings: [PairingInfo]?
    let error: String?
}

struct BridgeInfo: Decodable {
    let initialized: Bool
    let relayUrl: String?
    let roomId: String?
    let webUrl: String?
    let hostName: String?
    let stateDir: String
    let version: String
}

enum AdminError: LocalizedError {
    case notConfigured(String)
    case http(Int, String)
    case transport(String)

    var errorDescription: String? {
        switch self {
        case .notConfigured(let detail): return detail
        case .http(let code, let body): return "管理接口返回 \(code)：\(body)"
        case .transport(let detail): return detail
        }
    }
}

final class AdminClient {
    static let stateDir: URL = {
        if let home = ProcessInfo.processInfo.environment["AGENT_BRIDGE_HOME"], !home.isEmpty {
            return URL(fileURLWithPath: home, isDirectory: true)
        }
        return FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/AgentBridge", isDirectory: true)
    }()

    static let portFileName = "admin-port"

    /// 中继地址在启动时从 `agent-bridge info` 读到，用来区分 preview / 生产默认端口。
    static var relayHint: String?

    static var port: Int {
        if let raw = ProcessInfo.processInfo.environment["AGENT_BRIDGE_ADMIN_PORT"],
           let value = validPort(Int(raw.trimmingCharacters(in: .whitespaces))) {
            return value
        }
        return readPortFile() ?? defaultPort
    }

    /// 环境变量存在时菜单栏保存的端口不生效，设置界面要据此提示。
    static var hasPortEnv: Bool {
        guard let raw = ProcessInfo.processInfo.environment["AGENT_BRIDGE_ADMIN_PORT"] else { return false }
        return validPort(Int(raw.trimmingCharacters(in: .whitespaces))) != nil
    }

    private static func validPort(_ value: Int?) -> Int? {
        guard let value, value >= 1024, value <= 65_535 else { return nil }
        return value
    }

    static var defaultPort: Int {
        let relay = relayHint ?? UserDefaults.standard.string(forKey: "relayUrl")
        return isPreviewRelay(relay) ? 47826 : 47825
    }

    static func isPreviewRelay(_ relay: String?) -> Bool {
        guard let relay, !relay.isEmpty else { return false }
        let host = URL(string: relay)?.host ?? relay
        return host.range(of: "preview", options: .caseInsensitive) != nil
            || host.range(of: "staging", options: .caseInsensitive) != nil
    }

    static func readPortFile() -> Int? {
        let path = stateDir.appendingPathComponent(portFileName)
        guard let text = try? String(contentsOf: path, encoding: .utf8) else { return nil }
        return validPort(Int(text.trimmingCharacters(in: .whitespacesAndNewlines)))
    }

    static func savePort(_ port: Int) throws {
        guard let value = validPort(port) else {
            throw AdminError.transport("端口必须在 1024–65535 之间")
        }
        try FileManager.default.createDirectory(
            at: stateDir,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        let path = stateDir.appendingPathComponent(portFileName)
        try "\(value)\n".write(to: path, atomically: true, encoding: .utf8)
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path.path)
    }

    /// 删掉保存的端口，回到按中继环境取默认值。
    static func clearPort() {
        try? FileManager.default.removeItem(at: stateDir.appendingPathComponent(portFileName))
    }

    private func token() throws -> String {
        let path = Self.stateDir.appendingPathComponent("admin-token")
        guard let text = try? String(contentsOf: path, encoding: .utf8) else {
            throw AdminError.notConfigured("Bridge 还没启动过，找不到管理令牌（\(path.path)）")
        }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            throw AdminError.notConfigured("管理令牌为空：\(path.path)")
        }
        return trimmed
    }

    func request(_ method: String, _ path: String, body: [String: Any]? = nil) async throws -> Data {
        let token = try token()
        guard let url = URL(string: "http://127.0.0.1:\(Self.port)\(path)") else {
            throw AdminError.transport("管理接口地址无效")
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 6
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            guard code == 200 else {
                throw AdminError.http(code, String(data: data, encoding: .utf8) ?? "")
            }
            return data
        } catch let error as AdminError {
            throw error
        } catch {
            throw AdminError.transport("Bridge 未响应（127.0.0.1:\(Self.port)）")
        }
    }

    func status() async throws -> Snapshot {
        let data = try await request("GET", "/status")
        return try JSONDecoder().decode(Snapshot.self, from: data)
    }

    func disconnect(_ deviceId: String) async throws {
        _ = try await request("POST", "/devices/\(deviceId)/disconnect")
    }

    func revoke(_ deviceId: String) async throws {
        _ = try await request("POST", "/devices/\(deviceId)/revoke")
    }

    @discardableResult
    func disconnectAll() async throws -> Int {
        let data = try await request("POST", "/devices/disconnect-all")
        let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        return object?["closed"] as? Int ?? 0
    }

    func revokeAll() async throws -> (revoked: Int, failed: [String]) {
        let data = try await request("POST", "/devices/revoke-all")
        let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        return (
            object?["revoked"] as? Int ?? 0,
            object?["failed"] as? [String] ?? []
        )
    }

    func invite() async throws -> String {
        let data = try await request("POST", "/invite", body: ["ttlSeconds": 300])
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let url = object["url"] as? String else {
            throw AdminError.transport("邀请响应无法解析")
        }
        return url
    }

    /// Turns one remote capability on or off. `ttl` nil keeps it on until turned off.
    func setDevtools(capability: String, enabled: Bool, ttlSeconds: Double?) async throws {
        var body: [String: Any] = ["capability": capability, "enabled": enabled]
        if let ttlSeconds { body["ttlSeconds"] = ttlSeconds }
        _ = try await request("POST", "/devtools", body: body)
    }
}

/// Runs the bridge CLI for the two things the admin API cannot answer: whether
/// this state directory is initialized at all, and `init` itself.
enum BridgeCLI {
    struct Result {
        let code: Int32
        let output: String
        let error: String
    }

    /// DMG 安装版把运行时和 CLI 放在 Contents/Resources 里，源码树和本机 Node 都不需要。
    static func bundledPath(_ relative: String) -> String? {
        guard let resources = Bundle.main.resourceURL else { return nil }
        let path = resources.appendingPathComponent(relative).path
        return FileManager.default.fileExists(atPath: path) ? path : nil
    }

    static func nodePath() -> String? {
        if let explicit = ProcessInfo.processInfo.environment["AGENT_BRIDGE_NODE"],
           FileManager.default.isExecutableFile(atPath: explicit) {
            return explicit
        }
        if let bundled = bundledPath("node/bin/node"),
           FileManager.default.isExecutableFile(atPath: bundled) {
            return bundled
        }
        for candidate in ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"] {
            if FileManager.default.isExecutableFile(atPath: candidate) { return candidate }
        }
        let nvm = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".nvm/versions/node")
        if let versions = try? FileManager.default.contentsOfDirectory(atPath: nvm.path).sorted(by: >) {
            for version in versions {
                let path = nvm.appendingPathComponent("\(version)/bin/node").path
                if FileManager.default.isExecutableFile(atPath: path) { return path }
            }
        }
        // GUI apps get a minimal PATH; ask the login shell where node lives.
        let shell = Process()
        shell.executableURL = URL(fileURLWithPath: "/bin/zsh")
        shell.arguments = ["-lc", "command -v node"]
        let pipe = Pipe()
        shell.standardOutput = pipe
        shell.standardError = FileHandle.nullDevice
        try? shell.run()
        shell.waitUntilExit()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        let path = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return path.isEmpty || !FileManager.default.isExecutableFile(atPath: path) ? nil : path
    }

    /// env override, else the CLI bundled into the app, else the source tree in Info.plist.
    static func scriptPath() -> String? {
        if let bin = ProcessInfo.processInfo.environment["AGENT_BRIDGE_BIN"], !bin.isEmpty,
           FileManager.default.fileExists(atPath: bin) {
            return bin
        }
        if let bundled = bundledPath("bridge/apps/bridge/dist/main.js") {
            return bundled
        }
        guard let repo = Bundle.main.object(forInfoDictionaryKey: "AgentBridgeRepo") as? String else {
            return nil
        }
        let path = (repo as NSString).appendingPathComponent("apps/bridge/dist/main.js")
        return FileManager.default.fileExists(atPath: path) ? path : nil
    }

    static func run(_ args: [String], timeout: TimeInterval = 20) -> Result? {
        guard let node = nodePath(), let script = scriptPath() else { return nil }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: node)
        process.arguments = [script] + args
        var environment = ProcessInfo.processInfo.environment
        environment["AGENT_BRIDGE_HOME"] = AdminClient.stateDir.path
        process.environment = environment
        let out = Pipe()
        let err = Pipe()
        process.standardOutput = out
        process.standardError = err

        do {
            try process.run()
        } catch {
            return Result(code: -1, output: "", error: error.localizedDescription)
        }
        let deadline = Date().addingTimeInterval(timeout)
        while process.isRunning && Date() < deadline {
            usleep(50_000)
        }
        if process.isRunning {
            process.terminate()
            return Result(code: -2, output: "", error: "命令超时")
        }
        let output = String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        let error = String(data: err.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        return Result(code: process.terminationStatus, output: output, error: error)
    }

    /// True when something already listens on the local admin port, even if it
    /// does not accept this state directory's token.
    static func adminPortBusy(_ port: Int) -> Bool {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { return false }
        defer { close(fd) }
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = in_port_t(UInt16(port).bigEndian)
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        let result = withUnsafePointer(to: &addr) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        return result == 0
    }

    static func info() -> BridgeInfo? {
        guard let result = run(["info"], timeout: 8), result.code == 0 else { return nil }
        let line = result.output.split(separator: "\n").last.map(String.init) ?? result.output
        guard let data = line.data(using: .utf8) else { return nil }
        guard let info = try? JSONDecoder().decode(BridgeInfo.self, from: data) else { return nil }
        // 端口默认值要跟中继环境一致：preview 47826、生产 47825。
        AdminClient.relayHint = info.relayUrl
        return info
    }
}

func relativeTime(_ millis: Double?) -> String {
    guard let millis, millis > 0 else { return "从未连接" }
    let seconds = max(0, Date().timeIntervalSince1970 - millis / 1000)
    if seconds < 60 { return "刚刚" }
    if seconds < 3600 { return "\(Int(seconds / 60)) 分钟前" }
    if seconds < 86_400 { return "\(Int(seconds / 3600)) 小时前" }
    return "\(Int(seconds / 86_400)) 天前"
}

// AppKit 的 UI 只能在主线程碰：`Task { }` 在 await 之后会跑到协作后台线程上，
// 之前在后台线程 new NSAlert 会直接抛 NSException（NSWindow 非主线程初始化）→ SIGABRT。
// 整类标 @MainActor，让所有 Task 继承主 actor 隔离。
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    // 顶层代码创建 delegate 时不在主 actor 上下文里，初始化本身不碰 UI，所以放行。
    nonisolated override init() {
        super.init()
    }

    private let client = AdminClient()
    private var statusItem: NSStatusItem!
    private var timer: Timer?
    private var snapshot: Snapshot?
    private var bridge: BridgeInfo?
    private var reachable = false
    private var lastError: String?
    private var bridgeProcess: Process?
    private var bridgeStartedAt: Date?
    private var autoStartAttempted = false
    private var pairWindow: NSWindow?
    private var pairTimer: Timer?
    private var pairCodeLabel: NSTextField?
    private var pairStatusLabel: NSTextField?
    private var pairUrlLabel: NSTextField?
    private var pairLink = ""
    private var pairDeviceCountBefore = 0
    private var pairSawChannel = false
    private var pairOpenedAt: Double = 0
    private let updater = Updater()
    private var updateTimer: Timer?
    private var promptedUpdate: String?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.image = NSImage(
            systemSymbolName: "antenna.radiowaves.left.and.right",
            accessibilityDescription: "Agent Bridge"
        )
        statusItem.button?.image?.isTemplate = true
        statusItem.button?.imagePosition = .imageLeading
        let menu = NSMenu()
        menu.delegate = self
        statusItem.menu = menu
        paint()
        updater.onChange = { [weak self] in self?.paint() }
        Task {
            // 先读一次 info，端口默认值要靠中继地址区分 preview / 生产。
            if bridge == nil { bridge = BridgeCLI.info() }
            await refresh()
            autoStartBridgeIfIdle()
        }
        timer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            Task { await self?.refresh() }
        }
        Task {
            try? await Task.sleep(nanoseconds: 5_000_000_000)
            await checkForUpdates(automatic: true)
        }
        updateTimer = Timer.scheduledTimer(withTimeInterval: 6 * 3600, repeats: true) { [weak self] _ in
            Task { await self?.checkForUpdates(automatic: true) }
        }
    }

    private func paint() {
        guard let button = statusItem.button else { return }
        let version = snapshot?.version ?? bridge?.version
        let update = updater.available.map { " · 可更新 \($0.tag)" } ?? ""
        let suffix = (version.map { " · v\($0)" } ?? "") + update
        if reachable {
            let online = snapshot?.connections.filter { $0.kind == "device" }.count ?? 0
            button.title = online > 0 ? " \(online)" : ""
            button.toolTip = (online > 0 ? "\(online) 个客户端已连接" : "Agent Bridge · 就绪") + suffix
        } else {
            button.title = ""
            let state = bridge?.initialized == true ? "Agent Bridge 未运行" : "Agent Bridge 尚未初始化"
            button.toolTip = state + suffix
        }
    }

    private func refresh() async {
        do {
            snapshot = try await client.status()
            reachable = true
            lastError = nil
        } catch {
            reachable = false
            if BridgeCLI.adminPortBusy(AdminClient.port) {
                lastError = "管理端口 \(AdminClient.port) 被另一份 Bridge 占用"
            } else {
                lastError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
                if let fresh = BridgeCLI.info() { bridge = fresh }
            }
        }
        paint()
    }

    // MARK: - Menu

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()

        if !reachable {
            let initialized = bridge?.initialized == true
            let state = initialized ? "Bridge 未运行" : "Bridge 尚未初始化"
            let version = bridge.map { " · v\($0.version)" } ?? ""
            menu.addItem(disabled(state + version))
            if let stateDir = bridge?.stateDir {
                menu.addItem(disabled("状态目录：\(stateDir)"))
            } else if !initialized {
                menu.addItem(disabled("状态目录：\(AdminClient.stateDir.path)"))
            }
            if let lastError, initialized { menu.addItem(disabled(lastError)) }
            menu.addItem(.separator())
            if initialized {
                let start = NSMenuItem(title: "启动 Bridge", action: #selector(startBridge), keyEquivalent: "")
                start.target = self
                start.isEnabled = BridgeCLI.nodePath() != nil && BridgeCLI.scriptPath() != nil
                menu.addItem(start)
                menu.addItem(item("打开日志", #selector(openLog), ""))
            } else {
                menu.addItem(item("初始化 Bridge…", #selector(initBridge), ""))
            }
            menu.addItem(item("管理端口…（\(AdminClient.port)）", #selector(changePort), ""))
            addUpdateItems(to: menu)
            menu.addItem(.separator())
            menu.addItem(item("刷新", #selector(refreshNow), "r"))
            menu.addItem(item("退出", #selector(quit), "q"))
            return
        }

        guard let snapshot else { return }
        menu.addItem(disabled("\(snapshot.hostName) · v\(snapshot.version) · 中继\(snapshot.relayOnline ? "在线" : "离线")"))
        if let error = snapshot.error {
            menu.addItem(disabled("设备列表读取失败：\(error)"))
        }
        menu.addItem(.separator())

        let active = snapshot.connections.filter { $0.kind == "device" }
        if snapshot.devices.isEmpty {
            menu.addItem(disabled("还没有配对过设备"))
        }
        for device in snapshot.devices {
            let revoked = device.revokedAt != nil
            let expired = device.expiresAt.map { $0 < Date().timeIntervalSince1970 * 1000 } ?? false
            let state = revoked ? "已作废" : expired ? "已过期" : device.online ? "在线" : "离线"
            let entry = NSMenuItem(
                title: "\(device.name) · \(state) · \(relativeTime(device.lastSeenAt))",
                action: nil,
                keyEquivalent: ""
            )
            entry.isEnabled = true
            entry.image = NSImage(
                systemSymbolName: device.online ? "circle.fill" : "circle",
                accessibilityDescription: state
            )
            entry.image?.isTemplate = true

            let sub = NSMenu()
            let cut = NSMenuItem(title: "断开连接", action: #selector(disconnectDevice(_:)), keyEquivalent: "")
            cut.target = self
            cut.representedObject = device.deviceId
            cut.isEnabled = device.online
            sub.addItem(cut)
            let revoke = NSMenuItem(title: "作废证书…", action: #selector(revokeDevice(_:)), keyEquivalent: "")
            revoke.target = self
            revoke.representedObject = device.deviceId
            revoke.isEnabled = !revoked
            sub.addItem(revoke)
            sub.addItem(.separator())
            sub.addItem(logMenuItem(for: device))
            entry.submenu = sub
            menu.addItem(entry)
        }

        if !snapshot.devices.isEmpty {
            menu.addItem(.separator())
            let disconnectAllItem = item("断开全部连接", #selector(disconnectAllDevices), "")
            disconnectAllItem.isEnabled = !snapshot.connections.isEmpty
            menu.addItem(disconnectAllItem)
            let revokeAllItem = item("作废全部证书…", #selector(revokeAllDevices), "")
            revokeAllItem.isEnabled = snapshot.devices.contains { $0.revokedAt == nil }
            menu.addItem(revokeAllItem)
        }

        if active.count > 0 {
            menu.addItem(disabled("当前连接 \(active.count) 条"))
        }
        menu.addItem(.separator())
        menu.addItem(item("邀请新设备…", #selector(inviteDevice), "i"))

        let devtools = snapshot.devtools
        let devItem = NSMenuItem(title: devtoolsTitle(devtools), action: nil, keyEquivalent: "")
        devItem.isEnabled = true
        let devSub = NSMenu()
        devSub.addItem(disabled("文件浏览（只读，仅当前项目目录）"))
        devSub.addItem(item("开启 1 小时", #selector(enableFilesOneHour), ""))
        devSub.addItem(item("开启 8 小时", #selector(enableFilesEightHours), ""))
        devSub.addItem(item("关闭", #selector(disableFiles), ""))
        devSub.addItem(.separator())
        devSub.addItem(disabled("命令执行（可写，可访问整台机器）"))
        devSub.addItem(item("开启 1 小时", #selector(enableTerminalOneHour), ""))
        devSub.addItem(item("开启 8 小时", #selector(enableTerminalEightHours), ""))
        devSub.addItem(item("关闭", #selector(disableTerminal), ""))
        devItem.submenu = devSub
        menu.addItem(devItem)

        menu.addItem(item("管理端口：\(AdminClient.port)…", #selector(changePort), ""))
        menu.addItem(item("在浏览器中打开", #selector(openWeb), "o"))
        addUpdateItems(to: menu)
        menu.addItem(item("刷新", #selector(refreshNow), "r"))
        menu.addItem(.separator())
        if bridgeProcess?.isRunning == true {
            menu.addItem(item("停止 Bridge", #selector(stopBridge), ""))
        }
        menu.addItem(item("打开日志", #selector(openLog), ""))
        menu.addItem(item("退出", #selector(quit), "q"))
    }

    private func devtoolsTitle(_ info: DevtoolsInfo?) -> String {
        let files = info?.files?.enabled == true
        let terminal = info?.terminal?.enabled == true
        guard files || terminal else { return "远程工具：已关闭" }
        let parts = [files ? "文件" : nil, terminal ? "命令" : nil].compactMap { $0 }
        return "远程工具：\(parts.joined(separator: " + ")) 已开启"
    }

    private func disabled(_ title: String) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.isEnabled = false
        return item
    }

    /// 版本区：有新版本给一条可点的更新项，检查/下载中只显示状态。
    private func addUpdateItems(to menu: NSMenu) {
        menu.addItem(.separator())
        if let release = updater.available, !updater.isBusy {
            menu.addItem(item("发现新版本 \(release.tag) — 立即更新", #selector(installUpdate), ""))
            if case .failed(let reason) = updater.phase {
                menu.addItem(disabled("上次更新失败：\(reason)"))
            }
        } else if updater.isBusy {
            menu.addItem(disabled(updater.summary))
        } else {
            menu.addItem(disabled("当前版本 v\(Updater.currentVersion)"))
            if let failure = updater.lastFailure {
                menu.addItem(disabled("检查更新失败：\(failure)"))
            }
        }
        if !updater.isBusy {
            menu.addItem(item("检查更新…", #selector(checkForUpdates), ""))
        }
    }

    /// 设备子菜单里的「最近操作日志」：先列最近三条，后面再挂一个「更多」子菜单放全部历史。
    private func logMenuItem(for device: DeviceInfo) -> NSMenuItem {
        let entry = NSMenuItem(title: "最近操作日志", action: nil, keyEquivalent: "")
        entry.isEnabled = true
        let sub = NSMenu()
        let lines = device.log ?? []
        if lines.isEmpty {
            sub.addItem(disabled("暂无操作记录"))
            entry.submenu = sub
            return entry
        }
        for line in lines.prefix(3) { sub.addItem(logLineItem(line)) }
        if lines.count > 3 {
            sub.addItem(.separator())
            let more = NSMenuItem(title: "更多…（共 \(lines.count) 条）", action: nil, keyEquivalent: "")
            more.isEnabled = true
            let moreSub = NSMenu()
            for line in lines { moreSub.addItem(logLineItem(line)) }
            more.submenu = moreSub
            sub.addItem(more)
        }
        entry.submenu = sub
        return entry
    }

    private func logLineItem(_ line: String) -> NSMenuItem {
        let item = disabled(line.count > 90 ? String(line.prefix(90)) + "…" : line)
        item.toolTip = line
        return item
    }

    private func item(_ title: String, _ action: Selector, _ key: String) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.target = self
        return item
    }

    // MARK: - Actions

    @objc private func refreshNow() {
        Task { await refresh() }
    }

    @objc private func checkForUpdates() {
        Task { await checkForUpdates(automatic: false) }
    }

    /// 自动检查发现新版本时弹一次确认；同一个版本在一次运行里只提示一次。
    private func checkForUpdates(automatic: Bool) async {
        await updater.check()
        guard automatic, pairWindow == nil,
              let release = updater.available, promptedUpdate != release.tag else { return }
        promptedUpdate = release.tag
        let prompt = NSAlert()
        prompt.messageText = "发现新版本 \(release.tag)"
        prompt.informativeText = "当前版本 v\(Updater.currentVersion)。点「立即更新」会下载 DMG、替换应用，完成后自动重启。"
        prompt.addButton(withTitle: "立即更新")
        prompt.addButton(withTitle: "稍后")
        NSApp.activate(ignoringOtherApps: true)
        if prompt.runModal() == .alertFirstButtonReturn { startUpdate(release) }
    }

    @objc private func installUpdate() {
        guard let release = updater.available else { return }
        let confirm = NSAlert()
        confirm.messageText = "更新到 \(release.tag)？"
        confirm.informativeText = "会下载安装包并替换当前应用，完成后自动重启。由菜单栏启动的 Bridge 会跟着重启。"
        confirm.addButton(withTitle: "更新")
        confirm.addButton(withTitle: "取消")
        NSApp.activate(ignoringOtherApps: true)
        guard confirm.runModal() == .alertFirstButtonReturn else { return }
        startUpdate(release)
    }

    private func startUpdate(_ release: GitHubRelease) {
        let bridgePid: Int? = {
            guard let process = bridgeProcess, process.isRunning else { return nil }
            return Int(process.processIdentifier)
        }()
        updater.install(release, bridgePid: bridgePid)
    }

    @objc private func disconnectDevice(_ sender: NSMenuItem) {
        guard let deviceId = sender.representedObject as? String else { return }
        Task {
            do {
                try await client.disconnect(deviceId)
                await refresh()
            } catch {
                alert("断开失败", error.localizedDescription)
            }
        }
    }

    @objc private func revokeDevice(_ sender: NSMenuItem) {
        guard let deviceId = sender.representedObject as? String else { return }
        let name = snapshot?.devices.first { $0.deviceId == deviceId }?.name ?? deviceId
        let confirm = NSAlert()
        confirm.messageText = "作废「\(name)」的证书？"
        confirm.informativeText = "作废后这个设备无法再连接，需要重新配对才能使用。"
        confirm.alertStyle = .warning
        confirm.addButton(withTitle: "作废")
        confirm.addButton(withTitle: "取消")
        NSApp.activate(ignoringOtherApps: true)
        guard confirm.runModal() == .alertFirstButtonReturn else { return }
        Task {
            do {
                try await client.revoke(deviceId)
                await refresh()
            } catch {
                alert("作废失败", error.localizedDescription)
            }
        }
    }

    @objc private func disconnectAllDevices() {
        Task {
            do {
                try await client.disconnectAll()
                await refresh()
            } catch {
                alert("断开失败", error.localizedDescription)
            }
        }
    }

    @objc private func revokeAllDevices() {
        let pending = snapshot?.devices.filter { $0.revokedAt == nil }.count ?? 0
        guard pending > 0 else { return }
        let confirm = NSAlert()
        confirm.messageText = "作废全部 \(pending) 个设备的证书？"
        confirm.informativeText = "作废后这些设备都无法再连接，需要重新配对才能使用。"
        confirm.alertStyle = .warning
        confirm.addButton(withTitle: "全部作废")
        confirm.addButton(withTitle: "取消")
        NSApp.activate(ignoringOtherApps: true)
        guard confirm.runModal() == .alertFirstButtonReturn else { return }
        Task {
            do {
                let result = try await client.revokeAll()
                await refresh()
                if !result.failed.isEmpty {
                    alert("部分设备作废失败", result.failed.joined(separator: "\n"))
                }
            } catch {
                alert("作废失败", error.localizedDescription)
            }
        }
    }

    @objc private func inviteDevice() {
        Task {
            do {
                let url = try await client.invite()
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(url, forType: .string)
                pairDeviceCountBefore = snapshot?.devices.count ?? 0
                showPairWindow(url: url)
            } catch {
                alert("生成邀请失败", error.localizedDescription)
            }
        }
    }

    @objc private func enableFilesOneHour() {
        setDevtools(capability: "files", enabled: true, ttlSeconds: 3_600)
    }

    @objc private func enableFilesEightHours() {
        setDevtools(capability: "files", enabled: true, ttlSeconds: 8 * 3_600)
    }

    @objc private func disableFiles() {
        setDevtools(capability: "files", enabled: false, ttlSeconds: nil)
    }

    @objc private func enableTerminalOneHour() {
        setDevtools(capability: "terminal", enabled: true, ttlSeconds: 3_600)
    }

    @objc private func enableTerminalEightHours() {
        setDevtools(capability: "terminal", enabled: true, ttlSeconds: 8 * 3_600)
    }

    @objc private func disableTerminal() {
        setDevtools(capability: "terminal", enabled: false, ttlSeconds: nil)
    }

    private func setDevtools(capability: String, enabled: Bool, ttlSeconds: Double?) {
        Task {
            do {
                try await client.setDevtools(capability: capability, enabled: enabled, ttlSeconds: ttlSeconds)
                await refresh()
            } catch {
                alert("设置远程工具失败", error.localizedDescription)
            }
        }
    }

    @objc private func copyPairLink() {
        guard !pairLink.isEmpty else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(pairLink, forType: .string)
    }

    /// 默认 CIContext 在没有可用 GPU 的会话里可能渲染不出图，退到软件渲染再试一次，
    /// 否则邀请窗口会只剩一片空白。
    private func qrCGImage(_ output: CIImage) -> CGImage? {
        let space = CGColorSpaceCreateDeviceRGB()
        return CIContext().createCGImage(output, from: output.extent, format: .RGBA8, colorSpace: space)
            ?? CIContext(options: [.useSoftwareRenderer: true])
                .createCGImage(output, from: output.extent, format: .RGBA8, colorSpace: space)
    }

    /// 邀请链接的二维码：手机相机扫一下就能直接打开配对页。放大时用最近邻插值，
    /// 否则模块边缘会被糊掉，扫码失败。
    private func makeQRImage(for text: String, points: CGFloat) -> NSImage? {
        guard let filter = CIFilter(name: "CIQRCodeGenerator"),
              let message = text.data(using: .utf8) else { return nil }
        filter.setValue(message, forKey: "inputMessage")
        filter.setValue("M", forKey: "inputCorrectionLevel")
        guard let output = filter.outputImage,
              let cgImage = qrCGImage(output) else { return nil }

        // 按 2x 出图，Retina 屏上才不会被系统插值。
        let pixels = Int(points * 2)
        guard let rep = NSBitmapImageRep(
            bitmapDataPlanes: nil,
            pixelsWide: pixels,
            pixelsHigh: pixels,
            bitsPerSample: 8,
            samplesPerPixel: 4,
            hasAlpha: true,
            isPlanar: false,
            colorSpaceName: .deviceRGB,
            bytesPerRow: 0,
            bitsPerPixel: 0
        ), let graphics = NSGraphicsContext(bitmapImageRep: rep) else { return nil }

        // 静区（quiet zone）是二维码规范的一部分，四周留出空白才能被识别。
        let margin = CGFloat(pixels) * 0.08
        let side = CGFloat(pixels) - margin * 2

        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = graphics
        graphics.imageInterpolation = .none
        NSColor.white.setFill()
        NSRect(x: 0, y: 0, width: pixels, height: pixels).fill()
        NSImage(cgImage: cgImage, size: output.extent.size)
            .draw(in: NSRect(x: margin, y: margin, width: side, height: side))
        NSGraphicsContext.restoreGraphicsState()

        rep.size = NSSize(width: points, height: points)
        let image = NSImage(size: NSSize(width: points, height: points))
        image.addRepresentation(rep)
        return image
    }

    /// The pairing page shows a confirm code derived from both keys. The bridge only
    /// learns it once the browser's handshake finishes, so this window keeps polling
    /// the admin snapshot and swaps the placeholder for the real code.
    private func showPairWindow(url: String) {
        closePairWindow()
        pairLink = url
        pairSawChannel = false
        pairOpenedAt = Date().timeIntervalSince1970 * 1000

        let width: CGFloat = 520
        let height: CGFloat = 520
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: width, height: height),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        window.title = "邀请新设备"
        window.center()
        window.isReleasedWhenClosed = false

        let content = NSView(frame: NSRect(x: 0, y: 0, width: width, height: height))

        let qrSide: CGFloat = 200
        if let qr = makeQRImage(for: url, points: qrSide) {
            let qrView = NSImageView(image: qr)
            qrView.frame = NSRect(x: (width - qrSide) / 2, y: height - 24 - qrSide, width: qrSide, height: qrSide)
            qrView.imageScaling = .scaleProportionallyUpOrDown
            content.addSubview(qrView)
        }

        let hint = NSTextField(wrappingLabelWithString: "用手机相机扫码打开配对页，或复制链接到浏览器。链接 5 分钟内有效；客户端显示的确认码要和下面一致，否则取消配对。")
        hint.frame = NSRect(x: 20, y: 240, width: width - 40, height: 48)
        hint.font = .systemFont(ofSize: 12)
        hint.textColor = .secondaryLabelColor

        let urlField = NSTextField(labelWithString: url)
        urlField.frame = NSRect(x: 20, y: 210, width: width - 40, height: 20)
        urlField.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
        urlField.lineBreakMode = .byTruncatingMiddle
        urlField.isSelectable = true
        urlField.toolTip = url

        let status = NSTextField(labelWithString: "等待设备打开链接…")
        status.frame = NSRect(x: 20, y: 182, width: width - 40, height: 20)
        status.font = .systemFont(ofSize: 13, weight: .medium)

        let code = NSTextField(labelWithString: "— — —")
        code.frame = NSRect(x: 20, y: 110, width: width - 40, height: 52)
        code.font = .monospacedDigitSystemFont(ofSize: 38, weight: .semibold)
        code.alignment = .center
        code.isSelectable = true

        let copy = NSButton(title: "复制链接", target: self, action: #selector(copyPairLink))
        copy.frame = NSRect(x: (width - 100) / 2, y: 64, width: 100, height: 24)
        copy.bezelStyle = .rounded

        for view in [hint, urlField, status, code, copy] { content.addSubview(view) }
        window.contentView = content
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        pairWindow = window
        pairUrlLabel = urlField
        pairStatusLabel = status
        pairCodeLabel = code

        pairTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor in await self?.pollPairing() }
        }
        Task { await pollPairing() }
    }

    private func pollPairing() async {
        guard let pairWindow, pairWindow.isVisible else {
            closePairWindow()
            return
        }
        do {
            let fresh = try await client.status()
            snapshot = fresh
            // 之前没配完的标签页可能在 Bridge 里留下旧配对通道，只认本窗口打开之后建立的，
            // 并在其中取最新的一条，避免窗口一直显示早已作废的确认码。
            let pairing = fresh.pairings?
                .filter { $0.since >= pairOpenedAt - 1000 }
                .max(by: { $0.since < $1.since })
            if let pairing {
                pairSawChannel = true
                if let code = pairing.code {
                    pairCodeLabel?.stringValue = code
                    pairCodeLabel?.textColor = .labelColor
                    pairStatusLabel?.stringValue = "核对这个确认码与客户端显示的是否一致"
                } else {
                    pairCodeLabel?.stringValue = "等待握手…"
                    pairStatusLabel?.stringValue = "设备已连接，正在建立加密通道…"
                }
                return
            }
            guard pairSawChannel else { return }
            // The channel vanished; a new device means the pairing went through.
            let added = fresh.devices.count > pairDeviceCountBefore
            pairStatusLabel?.stringValue = added ? "配对完成" : "配对已取消或连接中断"
            pairCodeLabel?.stringValue = added ? "已配对" : "已结束"
            pairTimer?.invalidate()
            pairTimer = nil
            NSSound.beep()
            if added {
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
                    Task { @MainActor in self?.closePairWindow() }
                }
            }
        } catch {
            pairStatusLabel?.stringValue = "Bridge 未响应：\(error.localizedDescription)"
        }
    }

    private func closePairWindow() {
        pairTimer?.invalidate()
        pairTimer = nil
        pairWindow?.orderOut(nil)
        pairWindow?.close()
        pairWindow = nil
        pairCodeLabel = nil
        pairStatusLabel = nil
        pairUrlLabel = nil
    }

    @objc private func openWeb() {
        guard let raw = snapshot?.webUrl, let url = URL(string: raw) else { return }
        NSWorkspace.shared.open(url)
    }

    @objc private func openLog() {
        let log = AdminClient.stateDir.appendingPathComponent("bridge.log")
        if FileManager.default.fileExists(atPath: log.path) {
            NSWorkspace.shared.open(log)
        } else {
            alert("还没有日志", "Bridge 启动后日志会写到：\(log.path)")
        }
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }

    // MARK: - Init / Bridge process

    @objc private func initBridge() {
        let defaults = UserDefaults.standard
        let relay = bridge?.relayUrl
            ?? defaults.string(forKey: "relayUrl")
            ?? "https://agent-bridge-preview.craftstead.app"

        let dialog = NSAlert()
        dialog.messageText = "初始化 Agent Bridge"
        dialog.informativeText = "选中继地址即可：房间号和凭据都在本机生成，中继只负责转发。"
        dialog.addButton(withTitle: "初始化")
        dialog.addButton(withTitle: "取消")

        let form = NSView(frame: NSRect(x: 0, y: 0, width: 360, height: 116))
        func field(_ row: Int, _ label: String, _ value: String) -> NSTextField {
            let y = 56 - row * 56
            let caption = NSTextField(labelWithString: label)
            caption.font = .systemFont(ofSize: 11)
            caption.textColor = .secondaryLabelColor
            caption.frame = NSRect(x: 0, y: y + 24, width: 360, height: 14)
            let input = NSTextField(frame: NSRect(x: 0, y: y, width: 360, height: 22))
            input.stringValue = value
            form.addSubview(caption)
            form.addSubview(input)
            return input
        }
        let relayField = field(0, "中继地址", relay)
        let nameField = field(1, "本机名称", Host.current().localizedName ?? "Mac")
        dialog.accessoryView = form

        NSApp.activate(ignoringOtherApps: true)
        guard dialog.runModal() == .alertFirstButtonReturn else { return }

        let relayValue = relayField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        let nameValue = nameField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !relayValue.isEmpty else {
            alert("信息不完整", "中继地址必须填写。")
            return
        }
        defaults.set(relayValue, forKey: "relayUrl")

        var args = ["init", "--relay", relayValue]
        if !nameValue.isEmpty { args += ["--name", nameValue] }
        guard let result = BridgeCLI.run(args, timeout: 30) else {
            alert("无法运行 Bridge", "找不到 node 或 apps/bridge/dist/main.js。")
            return
        }
        guard result.code == 0 else {
            alert("初始化失败", (result.error.isEmpty ? result.output : result.error).trimmingCharacters(in: .whitespacesAndNewlines))
            return
        }
        bridge = BridgeCLI.info()
        startBridge()
    }

    /// App 启动时如果已经初始化、Bridge 又没在跑，就直接拉起来，省得每次开机手动点。
    /// 端口被别的实例占着、找不到 node 或脚本时保持静默，交给菜单里的「启动 Bridge」人工处理。
    private func autoStartBridgeIfIdle() {
        guard !autoStartAttempted else { return }
        autoStartAttempted = true
        guard !reachable, bridge?.initialized == true, bridgeProcess == nil else { return }
        guard BridgeCLI.nodePath() != nil, BridgeCLI.scriptPath() != nil else { return }
        guard !BridgeCLI.adminPortBusy(AdminClient.port) else { return }
        startBridge()
    }

    @objc private func startBridge() {
        if BridgeCLI.adminPortBusy(AdminClient.port) {
            alert(
                "已有 Bridge 在运行",
                "127.0.0.1:\(AdminClient.port) 已被占用，通常是另一份状态目录的 Bridge（例如终端里用 AGENT_BRIDGE_HOME 启动的 preview 实例）。先停掉它，或在菜单「管理端口」里换一个端口。"
            )
            Task { await refresh() }
            return
        }
        guard let node = BridgeCLI.nodePath() else {
            alert("找不到 node", "设置环境变量 AGENT_BRIDGE_NODE 指向 node 可执行文件。")
            return
        }
        guard let script = BridgeCLI.scriptPath() else {
            alert("找不到 Bridge", "设置环境变量 AGENT_BRIDGE_BIN 指向 apps/bridge/dist/main.js。")
            return
        }
        let stateDir = AdminClient.stateDir
        try? FileManager.default.createDirectory(
            at: stateDir,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        // 目录已存在时 attributes 不生效，老版本留下的宽松权限要单独收紧。
        try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: stateDir.path)

        let process = Process()
        process.executableURL = URL(fileURLWithPath: node)
        process.arguments = [script, "serve"]
        var environment = ProcessInfo.processInfo.environment
        environment["AGENT_BRIDGE_HOME"] = stateDir.path
        process.environment = environment

        let logPath = stateDir.appendingPathComponent("bridge.log")
        if !FileManager.default.fileExists(atPath: logPath.path) {
            FileManager.default.createFile(
                atPath: logPath.path,
                contents: nil,
                attributes: [.posixPermissions: 0o600]
            )
        }
        // 老版本留下的日志可能是 0644，打开前收紧一次。
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: logPath.path)
        if let handle = try? FileHandle(forWritingTo: logPath) {
            handle.seekToEndOfFile()
            process.standardOutput = handle
            process.standardError = handle
        }
        do {
            try process.run()
        } catch {
            alert("启动失败", error.localizedDescription)
            return
        }
        bridgeProcess = process
        let startedAt = Date()
        bridgeStartedAt = startedAt
        // A serve process that dies right away means it refused to start; surface why.
        DispatchQueue.global().async { [weak self] in
            process.waitUntilExit()
            let exitedFast = Date().timeIntervalSince(startedAt) < 5
            guard exitedFast, process.terminationStatus != 0 else { return }
            let tail = (try? String(contentsOf: logPath, encoding: .utf8))?
                .split(separator: "\n").suffix(6).joined(separator: "\n") ?? ""
            let code = process.terminationStatus
            Task { @MainActor in
                self?.bridgeProcess = nil
                self?.alert("Bridge 启动失败", tail.isEmpty ? "进程已退出（代码 \(code)）" : tail)
            }
        }
        Task {
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            await refresh()
        }
    }

    @objc private func stopBridge() {
        guard let process = bridgeProcess, process.isRunning else { return }
        process.terminate()
        bridgeProcess = nil
        Task {
            try? await Task.sleep(nanoseconds: 800_000_000)
            await refresh()
        }
    }

    /// 端口按状态目录保存：preview 与生产的 Bridge 各用各的，可以同时运行。
    @objc private func changePort() {
        let current = AdminClient.port
        let dialog = NSAlert()
        dialog.messageText = "管理端口"
        dialog.informativeText = "本地管理接口只监听 127.0.0.1。preview 默认 47826，生产默认 47825；留空恢复按中继环境取默认值。保存后会重启菜单栏启动的 Bridge。"
        dialog.addButton(withTitle: "保存")
        dialog.addButton(withTitle: "取消")
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 220, height: 22))
        field.stringValue = String(current)
        field.placeholderString = "1024–65535，留空用默认"
        dialog.accessoryView = field
        NSApp.activate(ignoringOtherApps: true)
        guard dialog.runModal() == .alertFirstButtonReturn else { return }

        if AdminClient.hasPortEnv {
            alert("环境变量优先", "当前设置了 AGENT_BRIDGE_ADMIN_PORT，菜单里保存的端口不会生效；删掉该环境变量并重开 App。")
            return
        }

        let raw = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        var target = current
        if raw.isEmpty {
            AdminClient.clearPort()
            target = AdminClient.defaultPort
        } else {
            guard let port = Int(raw), port >= 1024, port <= 65_535 else {
                alert("端口不合法", "请填 1024–65535 之间的整数，或留空恢复默认。")
                return
            }
            do {
                try AdminClient.savePort(port)
            } catch {
                alert("保存端口失败", error.localizedDescription)
                return
            }
            target = port
        }
        guard target != current else { return }

        // 只有菜单栏自己启动的进程才能代为重启；外部实例只保存设置并提示。
        guard bridgeProcess?.isRunning == true else {
            if reachable {
                alert("端口已保存", "当前运行的 Bridge 不是菜单栏启动的，需要手动重启后才会监听 127.0.0.1:\(target)。")
            } else {
                Task { await refresh() }
            }
            return
        }
        restartBridge()
    }

    private func restartBridge() {
        guard let process = bridgeProcess, process.isRunning else {
            startBridge()
            return
        }
        bridgeProcess = nil
        process.terminate()
        DispatchQueue.global().async { [weak self] in
            let deadline = Date().addingTimeInterval(5)
            while process.isRunning && Date() < deadline {
                usleep(50_000)
            }
            Task { @MainActor in
                // 端口文件已经改好，startBridge 会按新端口检查占用并启动。
                self?.startBridge()
            }
        }
    }

    private func alert(_ title: String, _ message: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message.isEmpty ? "（没有更多信息）" : message
        alert.alertStyle = .informational
        alert.addButton(withTitle: "好")
        NSApp.activate(ignoringOtherApps: true)
        alert.runModal()
    }
}

let app = NSApplication.shared

// `--dump` prints one status line and exits; used to verify the admin API
// without a GUI session.
if CommandLine.arguments.contains("--dump") {
    Task {
        _ = BridgeCLI.info() // 让端口默认值按中继环境取
        do {
            let snapshot = try await AdminClient().status()
            let devices = snapshot.devices.map { "\($0.name)(\($0.online ? "在线" : "离线"))" }
            print("ok relay=\(snapshot.relayOnline) connections=\(snapshot.connections.count) devices=\(devices.joined(separator: ","))")
            exit(0)
        } catch {
            print("fail \((error as? LocalizedError)?.errorDescription ?? error.localizedDescription)")
            print("node=\(BridgeCLI.nodePath() ?? "(未找到)")")
            print("script=\(BridgeCLI.scriptPath() ?? "(未找到)")")
            if let info = BridgeCLI.info() {
                print("initialized=\(info.initialized) stateDir=\(info.stateDir)")
            } else {
                print("initialized=unknown（info 无法运行）")
            }
            exit(1)
        }
    }
    RunLoop.main.run()
}

let delegate = AppDelegate()
app.delegate = delegate
app.run()
