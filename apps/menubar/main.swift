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

/// 客户端发来的一条用户消息：谁发的、发到哪个会话、正文前 500 字。
struct ReceivedMessage: Decodable {
    let at: Double
    let deviceId: String
    let deviceName: String
    let sessionId: String
    let title: String?
    let project: String?
    let agent: String?
    let text: String
}

/// 托管会话的设定，对应状态目录里的 hosted.json。
struct HostedConfig: Decodable {
    let allowBypassPermissions: Bool
    let dirs: [String]
    let idleTimeoutMs: Double
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

    /// 最近从客户端发过来的用户消息；`since` 是毫秒时间戳，0 表示取最近一批。
    func messages(since: Double) async throws -> [ReceivedMessage] {
        let data = try await request("GET", "/messages?since=\(Int(since))")
        struct Payload: Decodable { let messages: [ReceivedMessage] }
        return try JSONDecoder().decode(Payload.self, from: data).messages
    }

    @discardableResult
    func purgeRevoked() async throws -> (purged: Int, failed: [String]) {
        let data = try await request("POST", "/devices/purge-revoked")
        let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        return (object?["purged"] as? Int ?? 0, object?["failed"] as? [String] ?? [])
    }

    func hostedConfig() async throws -> HostedConfig {
        let data = try await request("GET", "/hosted")
        return try JSONDecoder().decode(HostedConfig.self, from: data)
    }

    func setHostedAllowBypass(_ enabled: Bool) async throws -> HostedConfig {
        let data = try await request("POST", "/hosted", body: ["allowBypassPermissions": enabled])
        return try JSONDecoder().decode(HostedConfig.self, from: data)
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

    // 设定窗口与消息气泡
    private var settingsWindow: NSWindow?
    private var settingsStatusDot: NSView?
    private var settingsStatusLabel: NSTextField?
    private var settingsRelayLabel: NSTextField?
    private var settingsRoomLabel: NSTextField?
    private var settingsStateDirLabel: NSTextField?
    private var settingsPortLabel: NSTextField?
    private var settingsBypassSwitch: NSSwitch?
    private var settingsDirsLabel: NSTextField?
    private var settingsIdleLabel: NSTextField?
    private var settingsFilesSwitch: NSSwitch?
    private var settingsTerminalSwitch: NSSwitch?
    private var settingsTable: NSTableView?
    private var settingsCountLabel: NSTextField?
    private var settingsEmptyLabel: NSTextField?
    private var settingsSearch: NSSearchField?
    private var messageFilter = ""
    private var hostedConfig: HostedConfig?
    private var messageLog: [ReceivedMessage] = []
    private var lastMessageAt: Double = 0
    private var messageTimer: Timer?
    private var bubbleWindow: NSWindow?
    private var bubbleToken = 0

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
        // 只看这之后到达的消息：刚启动时不该把历史消息全弹一遍。
        lastMessageAt = Date().timeIntervalSince1970 * 1000
        messageTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
            Task { await self?.pollMessages() }
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
        if settingsWindow?.isVisible == true { renderSettings() }
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
            menu.addItem(item("设定…", #selector(showSettings), ","))
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
            let purgeItem = item("删除全部作废的设备…", #selector(purgeRevokedDevices), "")
            purgeItem.isEnabled = snapshot.devices.contains { $0.revokedAt != nil }
            menu.addItem(purgeItem)
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

        menu.addItem(item("设定…", #selector(showSettings), ","))
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
            menu.addItem(disabled("菜单栏 app v\(Updater.currentVersion)"))
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
        prompt.informativeText = "菜单栏 app 当前 v\(Updater.currentVersion)。点「立即更新」会下载 DMG、替换应用，完成后自动重启。"
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

    /// 彻底删掉已作废的设备：中继那份设备清单和本地记录都会消失，操作日志一并清掉。
    @objc private func purgeRevokedDevices() {
        let revoked = snapshot?.devices.filter { $0.revokedAt != nil } ?? []
        guard !revoked.isEmpty else { return }
        let confirm = NSAlert()
        confirm.messageText = "删除全部 \(revoked.count) 个作废的设备？"
        confirm.informativeText = "会把它们从本机和中继的设备清单里彻底删掉（连同操作日志），无法恢复。证书本来就已经作废，删除只是清理列表。"
        confirm.alertStyle = .warning
        confirm.addButton(withTitle: "删除")
        confirm.addButton(withTitle: "取消")
        NSApp.activate(ignoringOtherApps: true)
        guard confirm.runModal() == .alertFirstButtonReturn else { return }
        Task {
            do {
                let result = try await client.purgeRevoked()
                await refresh()
                if !result.failed.isEmpty {
                    alert("部分设备删除失败", result.failed.joined(separator: "\n"))
                }
            } catch {
                alert("删除失败", error.localizedDescription)
            }
        }
    }

    // MARK: - 设定窗口

    @objc private func showSettings() {
        if let window = settingsWindow {
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            Task {
                await loadHostedConfig()
                await loadMessageHistory()
                renderSettings()
                renderMessageLog()
            }
            return
        }
        let width: CGFloat = 620
        let height: CGFloat = 620
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: width, height: height),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        window.title = "Agent Bridge 设定"
        window.isReleasedWhenClosed = false
        window.center()

        let tabs = NSTabView(frame: NSRect(x: 0, y: 0, width: width, height: height))
        tabs.autoresizingMask = [.width, .height]
        let general = NSTabViewItem(identifier: "general")
        general.label = "常规"
        general.view = buildGeneralTab(size: NSSize(width: width, height: height - 40))
        let log = NSTabViewItem(identifier: "log")
        log.label = "日志"
        log.view = buildLogTab(size: NSSize(width: width, height: height - 40))
        tabs.addTabViewItem(general)
        tabs.addTabViewItem(log)
        window.contentView = tabs
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        settingsWindow = window

        Task {
            await loadHostedConfig()
            await loadMessageHistory()
            renderSettings()
            renderMessageLog()
        }
    }

    private func valueLabel(_ text: String, mono: Bool = false) -> NSTextField {
        let label = NSTextField(labelWithString: text)
        label.font = mono ? .monospacedSystemFont(ofSize: 11, weight: .regular) : .systemFont(ofSize: 12)
        label.lineBreakMode = .byTruncatingMiddle
        label.isSelectable = true
        return label
    }

    private func buildGeneralTab(size: NSSize) -> NSView {
        let view = NSView(frame: NSRect(x: 0, y: 0, width: size.width, height: size.height))
        view.autoresizingMask = [.width, .height]
        let margin: CGFloat = 24
        let labelWidth: CGFloat = 128
        let valueX = margin + labelWidth + 12
        let valueWidth = size.width - valueX - margin
        var y = size.height - 16

        func take(_ height: CGFloat, gap: CGFloat = 8) -> CGFloat {
            y -= height
            let origin = y
            y -= gap
            return origin
        }
        func section(_ title: String) {
            let rule = NSBox(frame: NSRect(x: margin, y: y + 4, width: size.width - margin * 2, height: 1))
            rule.boxType = .separator
            view.addSubview(rule)
            y -= 20
            let label = NSTextField(labelWithString: title)
            label.font = .systemFont(ofSize: 11, weight: .semibold)
            label.textColor = .secondaryLabelColor
            label.frame = NSRect(x: margin, y: take(14, gap: 4), width: size.width - margin * 2, height: 14)
            view.addSubview(label)
        }
        func row(_ caption: String, _ field: NSTextField, height: CGFloat = 17) {
            let top = take(height, gap: 10)
            let label = NSTextField(labelWithString: caption)
            label.font = .systemFont(ofSize: 12)
            label.textColor = .secondaryLabelColor
            label.alignment = .right
            label.lineBreakMode = .byTruncatingTail
            label.frame = NSRect(x: margin, y: top + 1, width: labelWidth, height: 16)
            field.frame = NSRect(x: valueX, y: top, width: valueWidth, height: height)
            view.addSubview(label)
            view.addSubview(field)
        }
        func toggle(_ title: String, _ action: Selector) -> NSSwitch {
            let top = take(22, gap: 10)
            let label = NSTextField(labelWithString: title)
            label.font = .systemFont(ofSize: 12)
            label.lineBreakMode = .byTruncatingTail
            label.frame = NSRect(x: margin, y: top + 3, width: size.width - margin * 2 - 60, height: 16)
            view.addSubview(label)
            let control = NSSwitch(frame: NSRect(x: size.width - margin - 38, y: top, width: 38, height: 22))
            control.target = self
            control.action = action
            view.addSubview(control)
            return control
        }
        func hint(_ text: String, height: CGFloat = 28) {
            let label = NSTextField(wrappingLabelWithString: text)
            label.font = .systemFont(ofSize: 11)
            label.textColor = .tertiaryLabelColor
            label.frame = NSRect(x: margin, y: take(height, gap: 10), width: size.width - margin * 2, height: height)
            view.addSubview(label)
        }

        // 顶部状态条：一个圆点 + 一行摘要，比一行纯文字更容易一眼看出好坏。
        let pill = NSView(frame: NSRect(x: margin, y: take(32, gap: 16), width: size.width - margin * 2, height: 32))
        pill.wantsLayer = true
        pill.layer?.cornerRadius = 9
        pill.layer?.backgroundColor = NSColor.unemphasizedSelectedContentBackgroundColor.cgColor
        let dot = NSView(frame: NSRect(x: 12, y: 12, width: 8, height: 8))
        dot.wantsLayer = true
        dot.layer?.cornerRadius = 4
        dot.layer?.backgroundColor = NSColor.systemGray.cgColor
        pill.addSubview(dot)
        let status = NSTextField(labelWithString: "…")
        status.font = .systemFont(ofSize: 12, weight: .medium)
        status.lineBreakMode = .byTruncatingTail
        status.frame = NSRect(x: 26, y: 8, width: pill.frame.width - 36, height: 16)
        pill.addSubview(status)
        view.addSubview(pill)
        settingsStatusDot = dot
        settingsStatusLabel = status

        section("连接")
        settingsRelayLabel = valueLabel("…")
        row("中继", settingsRelayLabel!)
        settingsRoomLabel = valueLabel("…", mono: true)
        row("房间号", settingsRoomLabel!)
        settingsStateDirLabel = valueLabel("…", mono: true)
        row("状态目录", settingsStateDirLabel!)

        section("管理端口")
        settingsPortLabel = valueLabel("…", mono: true)
        row("本机接口", settingsPortLabel!)
        let portButton = NSButton(title: "修改…", target: self, action: #selector(changePort))
        portButton.bezelStyle = .rounded
        portButton.controlSize = .small
        portButton.font = .systemFont(ofSize: 11)
        if let portLabel = settingsPortLabel {
            portLabel.frame.size.width = max(60, valueWidth - 74)
            portButton.frame = NSRect(x: size.width - margin - 64, y: portLabel.frame.origin.y - 2, width: 64, height: 20)
        }
        view.addSubview(portButton)

        section("托管会话")
        settingsBypassSwitch = toggle("允许 bypassPermissions（跳过权限确认）", #selector(toggleBypass(_:)))
        hint("打开后网页可以给托管会话选 bypassPermissions，不再逐条询问权限。只在你信任远端操作时打开。")
        settingsDirsLabel = valueLabel("…")
        row("托管目录", settingsDirsLabel!)
        settingsIdleLabel = valueLabel("…")
        row("空闲超时", settingsIdleLabel!)

        section("远程工具")
        settingsFilesSwitch = toggle("文件浏览（只读，仅当前项目目录）", #selector(toggleFiles(_:)))
        settingsTerminalSwitch = toggle("命令执行（可写，可访问整台机器）", #selector(toggleTerminal(_:)))
        hint("开关立即生效；菜单里的「开启 1 小时 / 8 小时」只是加个自动关闭的时限。", height: 16)

        return view
    }

    private func buildLogTab(size: NSSize) -> NSView {
        let view = NSView(frame: NSRect(x: 0, y: 0, width: size.width, height: size.height))
        view.autoresizingMask = [.width, .height]
        let margin: CGFloat = 24

        let search = NSSearchField(frame: NSRect(x: margin, y: size.height - 44, width: size.width - margin * 2 - 92, height: 24))
        search.autoresizingMask = [.width]
        search.placeholderString = "按设备、工程、agent 或内容过滤"
        search.sendsSearchStringImmediately = true
        search.target = self
        search.action = #selector(filterMessages(_:))
        view.addSubview(search)
        settingsSearch = search

        let count = NSTextField(labelWithString: "")
        count.font = .monospacedDigitSystemFont(ofSize: 11, weight: .regular)
        count.textColor = .secondaryLabelColor
        count.alignment = .right
        count.frame = NSRect(x: size.width - margin - 80, y: size.height - 40, width: 80, height: 14)
        count.autoresizingMask = [.minXMargin]
        view.addSubview(count)
        settingsCountLabel = count

        let scroll = NSScrollView(frame: NSRect(x: margin, y: margin, width: size.width - margin * 2, height: size.height - 44 - margin))
        scroll.autoresizingMask = [.width, .height]
        scroll.hasVerticalScroller = true
        scroll.borderType = .noBorder
        scroll.wantsLayer = true
        scroll.layer?.cornerRadius = 8
        scroll.layer?.borderWidth = 1
        scroll.layer?.borderColor = NSColor.separatorColor.cgColor

        let table = NSTableView()
        table.style = .plain
        table.rowHeight = 26
        table.intercellSpacing = NSSize(width: 10, height: 2)
        table.usesAlternatingRowBackgroundColors = true
        table.allowsColumnResizing = true
        table.allowsEmptySelection = true
        table.dataSource = self
        table.delegate = self
        table.headerView = NSTableHeaderView()
        let columns: [(String, String, CGFloat)] = [
            ("time", "时间", 92),
            ("device", "来自", 128),
            ("project", "工程", 132),
            ("agent", "agent", 84),
            ("message", "标题与正文", 0),
        ]
        for (id, title, width) in columns {
            let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier(id))
            column.title = title
            column.width = width
            column.minWidth = 56
            if id == "message" { column.resizingMask = .autoresizingMask }
            table.addTableColumn(column)
        }
        scroll.documentView = table
        view.addSubview(scroll)
        settingsTable = table

        let empty = NSTextField(labelWithString: "还没有收到客户端发来的消息")
        empty.font = .systemFont(ofSize: 12)
        empty.textColor = .tertiaryLabelColor
        empty.alignment = .center
        empty.frame = NSRect(x: margin, y: scroll.frame.midY - 8, width: size.width - margin * 2, height: 16)
        empty.autoresizingMask = [.width]
        view.addSubview(empty)
        settingsEmptyLabel = empty
        return view
    }

    private func loadHostedConfig() async {
        guard reachable else {
            hostedConfig = nil
            return
        }
        hostedConfig = try? await client.hostedConfig()
    }

    private func loadMessageHistory() async {
        guard reachable else { return }
        guard let history = try? await client.messages(since: 0) else { return }
        messageLog = history
        if let latest = history.map({ $0.at }).max() { lastMessageAt = max(lastMessageAt, latest) }
    }

    private func renderSettings() {
        guard let window = settingsWindow, window.isVisible else { return }
        let version = snapshot?.version ?? bridge?.version ?? Updater.currentVersion
        let relayOnline = reachable && snapshot?.relayOnline == true
        settingsStatusDot?.layer?.backgroundColor =
            (reachable ? (relayOnline ? NSColor.systemGreen : NSColor.systemOrange) : NSColor.systemRed).cgColor
        if reachable, let snapshot {
            settingsStatusLabel?.stringValue =
                "\(snapshot.hostName) · v\(version) · 中继\(snapshot.relayOnline ? "在线" : "离线")"
            settingsRelayLabel?.stringValue = bridge?.relayUrl ?? snapshot.webUrl
            settingsRoomLabel?.stringValue = snapshot.roomId
            settingsStateDirLabel?.stringValue = bridge?.stateDir ?? AdminClient.stateDir.path
            settingsFilesSwitch?.state = snapshot.devtools?.files?.enabled == true ? .on : .off
            settingsTerminalSwitch?.state = snapshot.devtools?.terminal?.enabled == true ? .on : .off
        } else {
            settingsStatusLabel?.stringValue = bridge?.initialized == true ? "Bridge 未运行" : "Bridge 尚未初始化"
            settingsRelayLabel?.stringValue = bridge?.relayUrl ?? "—"
            settingsRoomLabel?.stringValue = bridge?.roomId ?? "—"
            settingsStateDirLabel?.stringValue = bridge?.stateDir ?? AdminClient.stateDir.path
            settingsFilesSwitch?.state = .off
            settingsTerminalSwitch?.state = .off
        }
        settingsStateDirLabel?.toolTip = settingsStateDirLabel?.stringValue
        settingsFilesSwitch?.isEnabled = reachable
        settingsTerminalSwitch?.isEnabled = reachable

        settingsPortLabel?.stringValue =
            "127.0.0.1:\(AdminClient.port)" + (AdminClient.hasPortEnv ? "（环境变量指定）" : "")

        if let hosted = hostedConfig {
            settingsBypassSwitch?.state = hosted.allowBypassPermissions ? .on : .off
            settingsDirsLabel?.stringValue = hosted.dirs.isEmpty
                ? "（没有可用的托管目录）"
                : hosted.dirs.joined(separator: "、")
            settingsDirsLabel?.toolTip = hosted.dirs.joined(separator: "\n")
            settingsIdleLabel?.stringValue = "\(Int((hosted.idleTimeoutMs / 60_000).rounded())) 分钟"
        } else {
            settingsBypassSwitch?.state = .off
            settingsDirsLabel?.stringValue = reachable ? "读取中…" : "Bridge 未运行，无法读取"
            settingsDirsLabel?.toolTip = nil
            settingsIdleLabel?.stringValue = ""
        }
        settingsBypassSwitch?.isEnabled = reachable && hostedConfig != nil
    }

    /// 日志 tab 的行：先按搜索词过滤，再按时间倒序。
    private func filteredMessages() -> [ReceivedMessage] {
        let rows = Array(messageLog.reversed())
        let needle = messageFilter.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !needle.isEmpty else { return rows }
        return rows.filter { message in
            [message.deviceName, message.project ?? "", message.agent ?? "", message.title ?? "", message.text]
                .joined(separator: " ")
                .lowercased()
                .contains(needle)
        }
    }

    private func renderMessageLog() {
        let rows = filteredMessages()
        settingsTable?.reloadData()
        settingsCountLabel?.stringValue = rows.isEmpty ? "" : "\(rows.count) 条"
        settingsEmptyLabel?.isHidden = !rows.isEmpty
        settingsEmptyLabel?.stringValue = messageLog.isEmpty
            ? "还没有收到客户端发来的消息"
            : "没有匹配的消息"
    }

    @objc private func filterMessages(_ sender: NSSearchField) {
        messageFilter = sender.stringValue
        renderMessageLog()
    }

    @objc private func toggleBypass(_ sender: NSSwitch) {
        let enabled = sender.state == .on
        sender.isEnabled = false
        Task {
            do {
                hostedConfig = try await client.setHostedAllowBypass(enabled)
            } catch {
                alert("保存失败", error.localizedDescription)
            }
            renderSettings()
        }
    }

    @objc private func toggleFiles(_ sender: NSSwitch) {
        setDevtools(capability: "files", enabled: sender.state == .on, ttlSeconds: nil)
    }

    @objc private func toggleTerminal(_ sender: NSSwitch) {
        setDevtools(capability: "terminal", enabled: sender.state == .on, ttlSeconds: nil)
    }

    // MARK: - 新消息气泡

    /// 每两秒问一次 Bridge 有没有新消息；有新消息就在状态图标下面弹一下。
    private func pollMessages() async {
        guard reachable else { return }
        guard let fresh = try? await client.messages(since: lastMessageAt), !fresh.isEmpty else { return }
        if let latest = fresh.map({ $0.at }).max() { lastMessageAt = max(lastMessageAt, latest) }
        messageLog.append(contentsOf: fresh)
        if messageLog.count > 200 { messageLog.removeFirst(messageLog.count - 200) }
        renderMessageLog()
        if let latest = fresh.last { showMessageBubble(latest) }
    }

    private func showMessageBubble(_ message: ReceivedMessage) {
        dismissBubble()
        let width: CGFloat = 340
        let inset: CGFloat = 14
        let textWidth = width - inset * 2
        let titleFont = NSFont.systemFont(ofSize: 13, weight: .semibold)
        let bodyFont = NSFont.systemFont(ofSize: 12)

        let title = message.title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let hasTitle = !title.isEmpty
        let titleHeight: CGFloat = hasTitle ? 17 : 0

        let bounds = (message.text as NSString).boundingRect(
            with: NSSize(width: textWidth, height: 10_000),
            options: [.usesLineFragmentOrigin, .usesFontLeading],
            attributes: [.font: bodyFont]
        )
        let bodyHeight = min(ceil(bounds.height), 96)
        let metaHeight: CGFloat = 13
        let height = inset + titleHeight + (hasTitle ? 3 : 0) + metaHeight + 6 + bodyHeight + inset

        let content = NSVisualEffectView(frame: NSRect(x: 0, y: 0, width: width, height: height))
        content.material = .popover
        content.blendingMode = .behindWindow
        content.state = .active
        content.wantsLayer = true
        content.layer?.cornerRadius = 12
        content.layer?.borderWidth = 1
        content.layer?.borderColor = NSColor.separatorColor.withAlphaComponent(0.6).cgColor
        content.layer?.masksToBounds = true

        var y = height - inset
        if hasTitle {
            y -= titleHeight
            let titleLabel = NSTextField(labelWithString: title)
            titleLabel.font = titleFont
            titleLabel.textColor = .labelColor
            titleLabel.lineBreakMode = .byTruncatingTail
            titleLabel.frame = NSRect(x: inset, y: y, width: textWidth, height: titleHeight)
            content.addSubview(titleLabel)
            y -= 3
        }

        var parts = [message.deviceName]
        if let project = message.project, !project.isEmpty { parts.append(project) }
        if let agent = message.agent, !agent.isEmpty { parts.append(agent) }
        y -= metaHeight
        let caption = NSTextField(labelWithString: parts.joined(separator: " · "))
        caption.font = .systemFont(ofSize: 10, weight: .medium)
        caption.textColor = .secondaryLabelColor
        caption.lineBreakMode = .byTruncatingTail
        caption.frame = NSRect(x: inset, y: y, width: textWidth, height: metaHeight)
        content.addSubview(caption)

        y -= 6 + bodyHeight
        let body = NSTextField(wrappingLabelWithString: message.text)
        body.font = bodyFont
        body.textColor = .secondaryLabelColor
        body.frame = NSRect(x: inset, y: y, width: textWidth, height: bodyHeight)
        content.addSubview(body)

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: width, height: height),
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        window.contentView = content
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = true
        window.level = .statusBar
        window.ignoresMouseEvents = true
        window.collectionBehavior = [.canJoinAllSpaces, .transient]

        // 贴在状态图标正下方；拿不到图标位置就退到屏幕右上角。
        if let host = statusItem.button?.window {
            window.setFrameOrigin(NSPoint(x: host.frame.maxX - width - 6, y: host.frame.minY - height - 6))
        } else if let screen = NSScreen.main {
            window.setFrameOrigin(NSPoint(
                x: screen.visibleFrame.maxX - width - 12,
                y: screen.visibleFrame.maxY - height - 12
            ))
        }
        window.alphaValue = 0
        window.orderFrontRegardless()

        bubbleWindow = window
        bubbleToken += 1
        let token = bubbleToken
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.18
            window.animator().alphaValue = 1
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 4.2) { [weak self] in
            Task { @MainActor in
                guard let self, self.bubbleToken == token else { return }
                self.bubbleWindow = nil
                NSAnimationContext.runAnimationGroup({ context in
                    context.duration = 0.6
                    window.animator().alphaValue = 0
                }, completionHandler: {
                    window.orderOut(nil)
                })
            }
        }
    }

    private func dismissBubble() {
        bubbleToken += 1
        bubbleWindow?.orderOut(nil)
        bubbleWindow = nil
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

// MARK: - 日志表格

extension AppDelegate: NSTableViewDataSource, NSTableViewDelegate {
    private static let logTimeFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "MM-dd HH:mm:ss"
        return formatter
    }()

    func numberOfRows(in tableView: NSTableView) -> Int {
        filteredMessages().count
    }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        guard let column = tableColumn else { return nil }
        let rows = filteredMessages()
        guard row >= 0, row < rows.count else { return nil }
        let message = rows[row]

        let identifier = NSUserInterfaceItemIdentifier("cell-\(column.identifier.rawValue)")
        let cell: NSTableCellView
        if let reused = tableView.makeView(withIdentifier: identifier, owner: self) as? NSTableCellView {
            cell = reused
        } else {
            cell = NSTableCellView()
            cell.identifier = identifier
            let field = NSTextField(labelWithString: "")
            field.lineBreakMode = .byTruncatingTail
            field.autoresizingMask = [.width, .maxYMargin, .minYMargin]
            cell.addSubview(field)
            cell.textField = field
        }
        guard let field = cell.textField else { return cell }
        field.frame = NSRect(x: 2, y: 5, width: max(column.width - 6, 20), height: 16)

        switch column.identifier.rawValue {
        case "time":
            field.font = .monospacedDigitSystemFont(ofSize: 11, weight: .regular)
            field.textColor = .secondaryLabelColor
            field.stringValue = Self.logTimeFormatter.string(from: Date(timeIntervalSince1970: message.at / 1000))
        case "device":
            field.font = .systemFont(ofSize: 12, weight: .medium)
            field.textColor = .labelColor
            field.stringValue = message.deviceName
        case "project":
            field.font = .systemFont(ofSize: 12)
            field.textColor = .labelColor
            field.stringValue = message.project ?? "—"
        case "agent":
            field.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
            field.textColor = .secondaryLabelColor
            field.stringValue = message.agent ?? "—"
        default:
            field.attributedStringValue = Self.messageSummary(message)
        }
        return cell
    }

    /// 消息列：有标题时标题在前，正文跟在后面；没有标题就只显示正文。
    private static func messageSummary(_ message: ReceivedMessage) -> NSAttributedString {
        let summary = NSMutableAttributedString()
        if let title = message.title?.trimmingCharacters(in: .whitespacesAndNewlines), !title.isEmpty {
            summary.append(NSAttributedString(string: title, attributes: [
                .font: NSFont.systemFont(ofSize: 12, weight: .semibold),
                .foregroundColor: NSColor.labelColor,
            ]))
            summary.append(NSAttributedString(string: "  ", attributes: [.font: NSFont.systemFont(ofSize: 12)]))
        }
        summary.append(NSAttributedString(string: message.text, attributes: [
            .font: NSFont.systemFont(ofSize: 12),
            .foregroundColor: NSColor.secondaryLabelColor,
        ]))
        return summary
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
