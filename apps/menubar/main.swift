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

    static var port: Int {
        if let raw = ProcessInfo.processInfo.environment["AGENT_BRIDGE_ADMIN_PORT"], let value = Int(raw) {
            return value
        }
        return 47825
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

    static func nodePath() -> String? {
        if let explicit = ProcessInfo.processInfo.environment["AGENT_BRIDGE_NODE"],
           FileManager.default.isExecutableFile(atPath: explicit) {
            return explicit
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

    /// env override, else the checkout recorded in Info.plist at build time.
    static func scriptPath() -> String? {
        if let bin = ProcessInfo.processInfo.environment["AGENT_BRIDGE_BIN"], !bin.isEmpty,
           FileManager.default.fileExists(atPath: bin) {
            return bin
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
        return try? JSONDecoder().decode(BridgeInfo.self, from: data)
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
    private var pairWindow: NSWindow?
    private var pairTimer: Timer?
    private var pairCodeLabel: NSTextField?
    private var pairStatusLabel: NSTextField?
    private var pairUrlLabel: NSTextField?
    private var pairLink = ""
    private var pairDeviceCountBefore = 0
    private var pairSawChannel = false

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
        Task { await refresh() }
        timer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            Task { await self?.refresh() }
        }
    }

    private func paint() {
        guard let button = statusItem.button else { return }
        if reachable {
            let online = snapshot?.connections.filter { $0.kind == "device" }.count ?? 0
            button.title = online > 0 ? " \(online)" : ""
            button.toolTip = online > 0 ? "\(online) 个客户端已连接" : "Agent Bridge · 就绪"
        } else {
            button.title = ""
            button.toolTip = bridge?.initialized == true ? "Agent Bridge 未运行" : "Agent Bridge 尚未初始化"
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
            menu.addItem(disabled(initialized ? "Bridge 未运行" : "Bridge 尚未初始化"))
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
            menu.addItem(.separator())
            menu.addItem(item("刷新", #selector(refreshNow), "r"))
            menu.addItem(item("退出", #selector(quit), "q"))
            return
        }

        guard let snapshot else { return }
        menu.addItem(disabled("\(snapshot.hostName) · 中继\(snapshot.relayOnline ? "在线" : "离线")"))
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
            entry.submenu = sub
            menu.addItem(entry)
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

        menu.addItem(item("在浏览器中打开", #selector(openWeb), "o"))
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

    private func item(_ title: String, _ action: Selector, _ key: String) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.target = self
        return item
    }

    // MARK: - Actions

    @objc private func refreshNow() {
        Task { await refresh() }
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

    /// 邀请链接的二维码：手机相机扫一下就能直接打开配对页。放大时用最近邻插值，
    /// 否则模块边缘会被糊掉，扫码失败。
    private func makeQRImage(for text: String, points: CGFloat) -> NSImage? {
        guard let filter = CIFilter(name: "CIQRCodeGenerator"),
              let message = text.data(using: .utf8) else { return nil }
        filter.setValue(message, forKey: "inputMessage")
        filter.setValue("M", forKey: "inputCorrectionLevel")
        guard let output = filter.outputImage,
              let cgImage = CIContext().createCGImage(output, from: output.extent) else { return nil }

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
            let pairing = fresh.pairings?.first
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
            ?? "https://agent-bridge-preview.gowinder.workers.dev"

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

    @objc private func startBridge() {
        if BridgeCLI.adminPortBusy(AdminClient.port) {
            alert(
                "已有 Bridge 在运行",
                "127.0.0.1:\(AdminClient.port) 已被占用，通常是另一份状态目录的 Bridge（例如终端里用 AGENT_BRIDGE_HOME 启动的那个）。先停掉它，或设置 AGENT_BRIDGE_ADMIN_PORT 区分。"
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
        try? FileManager.default.createDirectory(at: stateDir, withIntermediateDirectories: true)

        let process = Process()
        process.executableURL = URL(fileURLWithPath: node)
        process.arguments = [script, "serve"]
        var environment = ProcessInfo.processInfo.environment
        environment["AGENT_BRIDGE_HOME"] = stateDir.path
        process.environment = environment

        let logPath = stateDir.appendingPathComponent("bridge.log")
        if !FileManager.default.fileExists(atPath: logPath.path) {
            FileManager.default.createFile(atPath: logPath.path, contents: nil)
        }
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
