// Agent Bridge menu bar app: shows who is connected to the local bridge, and
// lets you cut a device off or revoke its credential without a terminal.
import AppKit
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

struct Snapshot: Decodable {
    let version: String
    let hostName: String
    let roomId: String
    let webUrl: String
    let relayOnline: Bool
    let bridgePid: Int
    let devices: [DeviceInfo]
    let connections: [ConnectionInfo]
    let error: String?
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
            throw AdminError.notConfigured("找不到管理令牌：\(path.path)。先在终端运行一次 agent-bridge serve。")
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
}

func relativeTime(_ millis: Double?) -> String {
    guard let millis, millis > 0 else { return "从未连接" }
    let seconds = max(0, Date().timeIntervalSince1970 - millis / 1000)
    if seconds < 60 { return "刚刚" }
    if seconds < 3600 { return "\(Int(seconds / 60)) 分钟前" }
    if seconds < 86_400 { return "\(Int(seconds / 3600)) 小时前" }
    return "\(Int(seconds / 86_400)) 天前"
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private let client = AdminClient()
    private var statusItem: NSStatusItem!
    private var timer: Timer?
    private var snapshot: Snapshot?
    private var reachable = false
    private var lastError: String?
    private var bridgeProcess: Process?

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
            button.toolTip = "Agent Bridge 未运行"
        }
    }

    private func refresh() async {
        do {
            snapshot = try await client.status()
            reachable = true
            lastError = nil
        } catch {
            reachable = false
            lastError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
        paint()
    }

    // MARK: - Menu

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()

        if !reachable {
            menu.addItem(disabled("Bridge 未运行"))
            if let lastError { menu.addItem(disabled(lastError)) }
            let start = NSMenuItem(title: "启动 Bridge", action: #selector(startBridge), keyEquivalent: "")
            start.target = self
            start.isEnabled = bridgeScript() != nil
            menu.addItem(start)
            menu.addItem(.separator())
            menu.addItem(item("退出", #selector(quit), "q"))
            return
        }

        guard let snapshot else { return }
        let header = disabled("\(snapshot.hostName) · 中继\(snapshot.relayOnline ? "在线" : "离线")")
        menu.addItem(header)
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
        menu.addItem(item("在浏览器中打开", #selector(openWeb), "o"))
        menu.addItem(item("刷新", #selector(refreshNow), "r"))
        menu.addItem(.separator())
        if bridgeProcess?.isRunning == true {
            menu.addItem(item("停止 Bridge", #selector(stopBridge), ""))
        }
        menu.addItem(item("退出", #selector(quit), "q"))
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
                alert("配对链接已复制", "5 分钟内有效，一次性使用。粘贴到浏览器打开即可配对。\n\n\(url)")
            } catch {
                alert("生成邀请失败", error.localizedDescription)
            }
        }
    }

    @objc private func openWeb() {
        guard let raw = snapshot?.webUrl, let url = URL(string: raw) else { return }
        NSWorkspace.shared.open(url)
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }

    // MARK: - Bridge process

    /// The bridge script this app should spawn: env override, else the copy next
    /// to the app bundle recorded at build time.
    private func bridgeScript() -> String? {
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

    @objc private func startBridge() {
        guard let script = bridgeScript() else {
            alert("找不到 Bridge", "设置环境变量 AGENT_BRIDGE_BIN 指向 apps/bridge/dist/main.js。")
            return
        }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["node", script, "serve"]
        var environment = ProcessInfo.processInfo.environment
        let logPath = AdminClient.stateDir.appendingPathComponent("bridge.log")
        environment["AGENT_BRIDGE_HOME"] = AdminClient.stateDir.path
        process.environment = environment
        if let handle = try? FileHandle(forWritingTo: logPath) {
            handle.seekToEndOfFile()
            process.standardOutput = handle
            process.standardError = handle
        } else {
            FileManager.default.createFile(atPath: logPath.path, contents: nil)
            if let handle = try? FileHandle(forWritingTo: logPath) {
                process.standardOutput = handle
                process.standardError = handle
            }
        }
        do {
            try process.run()
            bridgeProcess = process
            Task {
                try? await Task.sleep(nanoseconds: 1_500_000_000)
                await refresh()
            }
        } catch {
            alert("启动失败", error.localizedDescription)
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
        alert.informativeText = message
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
            exit(1)
        }
    }
    RunLoop.main.run()
}

let delegate = AppDelegate()
app.delegate = delegate
app.run()
