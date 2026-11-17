// 菜单栏 app 的版本检测与自更新：查 GitHub Release、下载 DMG、校验，
// 再交给一个脱离本进程的脚本等 App 退出后替换应用包并重新打开。
import AppKit
import CryptoKit
import Foundation

struct GitHubAsset: Decodable {
    let name: String
    let url: String

    enum CodingKeys: String, CodingKey {
        case name
        case url = "browser_download_url"
    }
}

struct GitHubRelease: Decodable {
    let tag: String
    let name: String?
    let prerelease: Bool
    let draft: Bool
    let assets: [GitHubAsset]

    enum CodingKeys: String, CodingKey {
        case tag = "tag_name"
        case name
        case prerelease
        case draft
        case assets
    }
}

enum UpdateError: LocalizedError {
    case message(String)

    var errorDescription: String? {
        switch self {
        case .message(let text): return text
        }
    }
}

enum VersionOrder {
    /// 先比数字段，数字相同再比预发布后缀：v0.1.10 > v0.1.9，v0.1.9 > v0.1.9-rc.2。
    static func isNewer(_ candidate: String, than current: String) -> Bool {
        let (left, leftPre) = split(candidate)
        let (right, rightPre) = split(current)
        for index in 0..<max(left.count, right.count) {
            let a = index < left.count ? left[index] : 0
            let b = index < right.count ? right[index] : 0
            if a != b { return a > b }
        }
        switch (leftPre, rightPre) {
        case (nil, nil): return false
        case (nil, _): return true
        case (_, nil): return false
        case let (a?, b?): return a.compare(b, options: .numeric) == .orderedDescending
        }
    }

    private static func split(_ value: String) -> ([Int], String?) {
        var text = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.hasPrefix("v") || text.hasPrefix("V") { text.removeFirst() }
        let parts = text.split(separator: "-", maxSplits: 1, omittingEmptySubsequences: false)
        let numbers = parts.first.map { $0.split(separator: ".").map { Int($0) ?? 0 } } ?? []
        let prerelease = parts.count > 1 ? String(parts[1]) : nil
        return (numbers, prerelease)
    }
}

/// GitHub Release 检查、下载、校验和替换。所有 UI 状态变化走 `onChange`，菜单打开时重新读。
@MainActor
final class Updater {
    enum Phase: Equatable {
        case idle
        case checking
        case downloading
        case installing
        case failed(String)
    }

    static let repo = "gowinder/agent-bridge"
    /// 优先读 build.sh 写进去的完整版本（含 `-rc.1`）。CFBundleShortVersionString 被 Apple
    /// 限制成 x.y.z，用它比较会让装过 rc.1 的 preview 用户收不到 rc.2，也收不到随后转正的同一个版本。
    static let currentVersion: String = {
        let full = Bundle.main.object(forInfoDictionaryKey: "AgentBridgeVersion") as? String
        let short = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
        return (full?.isEmpty == false ? full : short) ?? "0.0.0"
    }()

    /// 装的是不是预发布（`0.11.1-rc.8`）。只有这种版本才有「允许升级到正式版」这个选项。
    static let currentVersionIsPrerelease = currentVersion.contains("-")

    /// 预览版是另一份独立安装（bundle id 带 .preview），固定跟着 prerelease 走：
    /// 让它升到正式版会把正式版装成同名的第二个 app，两边互相顶。
    static let isPreviewInstall = Bundle.main.bundleIdentifier?.hasSuffix(".preview") == true

    /// 装的是测试版时，是否允许升到正式版。默认关：装 rc 的人只跟着 rc 走，
    /// 正式版不会把测试版顶掉。正式版机器上恒为 false，选项也不显示。
    static var allowsReleaseUpgrade: Bool {
        get {
            guard currentVersionIsPrerelease, !isPreviewInstall else { return false }
            let defaults = UserDefaults.standard
            if let value = defaults.object(forKey: "allowReleaseUpgrade") as? Bool { return value }
            // 旧键 prereleaseChannel 是反义（true = 停留在测试版），读一次完成迁移。
            if let legacy = defaults.object(forKey: "prereleaseChannel") as? Bool { return !legacy }
            return false
        }
        set { UserDefaults.standard.set(newValue, forKey: "allowReleaseUpgrade") }
    }

    private(set) var phase: Phase = .idle
    private(set) var available: GitHubRelease?
    private(set) var lastChecked: Date?
    private(set) var lastFailure: String?
    var onChange: (() -> Void)?

    /// 换了更新通道后旧候选就不再适用，菜单/工具提示不该继续显示它。
    func clearAvailable() {
        available = nil
        onChange?()
    }

    var isBusy: Bool {
        switch phase {
        case .checking, .downloading, .installing: return true
        case .idle, .failed: return false
        }
    }

    var summary: String {
        switch phase {
        case .checking: return T("正在检查更新…")
        case .downloading: return TF("正在下载 %@…", available?.tag ?? T("新版本"))
        case .installing: return T("正在安装，安装完成后会自动重启")
        case .failed(let reason): return TF("更新失败：%@", reason)
        // 菜单顶部那行是 Bridge 的版本；这里写清楚是菜单栏 app 自己的版本，两者会分开升级。
        case .idle: return TF("菜单栏 app v%@", Self.currentVersion)
        }
    }

    func check() async {
        guard !isBusy else { return }
        phase = .checking
        onChange?()
        defer {
            lastChecked = Date()
            if case .checking = phase { phase = .idle }
            onChange?()
        }
        do {
            let releases = try await fetchReleases()
            // 通道只看当前装的是哪一档，不看中继：正式版只认正式版 DMG；
            // 测试版默认只认预发布，勾了「允许升级到正式版」才把正式版也算进来。
            let allowRelease = Self.allowsReleaseUpgrade
            let candidates = releases.filter { release in
                guard !release.draft else { return false }
                if Self.currentVersionIsPrerelease {
                    if !release.prerelease && !allowRelease { return false }
                } else if release.prerelease {
                    return false
                }
                return VersionOrder.isNewer(release.tag, than: Self.currentVersion)
            }
            // 取版本号最高的那个，而不是接口返回的第一个，避免旧版本后发时把人降级。
            available = candidates.reduce(nil as GitHubRelease?) { best, release in
                guard let best else { return release }
                return VersionOrder.isNewer(release.tag, than: best.tag) ? release : best
            }
            lastFailure = nil
        } catch {
            available = nil
            lastFailure = error.localizedDescription
        }
    }

    func install(_ release: GitHubRelease, bridgePid: Int?) {
        guard !isBusy else { return }
        available = release
        guard let asset = release.assets.first(where: { $0.name == "AgentBridge.dmg" })
            ?? release.assets.first(where: { $0.name.lowercased().hasSuffix(".dmg") && !$0.name.hasSuffix(".sha256") }) else {
            phase = .failed(T("这个版本没有 DMG 附件"))
            onChange?()
            return
        }
        phase = .downloading
        onChange?()
        Task { await download(asset, release: release, bridgePid: bridgePid) }
    }

    // MARK: - Steps

    private func fetchReleases() async throws -> [GitHubRelease] {
        guard let url = URL(string: "https://api.github.com/repos/\(Self.repo)/releases?per_page=20") else {
            throw UpdateError.message(T("发布地址无效"))
        }
        var request = URLRequest(url: url)
        request.timeoutInterval = 15
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        request.setValue("AgentBridge-menubar", forHTTPHeaderField: "User-Agent")
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let status = (response as? HTTPURLResponse)?.statusCode else {
            throw UpdateError.message(T("发布接口没有响应"))
        }
        guard status == 200 else { throw UpdateError.message(TF("发布接口返回 %d", status)) }
        return try JSONDecoder().decode([GitHubRelease].self, from: data)
    }

    private func download(_ asset: GitHubAsset, release: GitHubRelease, bridgePid: Int?) async {
        do {
            var request = URLRequest(url: URL(string: asset.url)!)
            request.timeoutInterval = 600
            request.setValue("AgentBridge-menubar", forHTTPHeaderField: "User-Agent")
            let (temporary, response) = try await URLSession.shared.download(for: request)
            guard let status = (response as? HTTPURLResponse)?.statusCode else {
                throw UpdateError.message(T("下载没有响应"))
            }
            guard status == 200 else { throw UpdateError.message(TF("下载失败（HTTP %d）", status)) }

            let work = FileManager.default.temporaryDirectory
                .appendingPathComponent("agentbridge-update-\(UUID().uuidString)", isDirectory: true)
            try FileManager.default.createDirectory(
                at: work,
                withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700]
            )
            let dmg = work.appendingPathComponent("AgentBridge.dmg")
            try FileManager.default.moveItem(at: temporary, to: dmg)

            try await verify(dmg, release: release)
            phase = .installing
            onChange?()
            try await stage(dmg, release: release, bridgePid: bridgePid)
        } catch {
            phase = .failed(error.localizedDescription)
            onChange?()
        }
    }

    /// Release 里带了 sha256 就必须对上，避免装到半截或被人换过的包。
    private func verify(_ dmg: URL, release: GitHubRelease) async throws {
        guard let asset = release.assets.first(where: { $0.name.hasSuffix(".sha256") }) else { return }
        var request = URLRequest(url: URL(string: asset.url)!)
        request.timeoutInterval = 15
        request.setValue("AgentBridge-menubar", forHTTPHeaderField: "User-Agent")
        let (data, response) = try await URLSession.shared.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200,
              let text = String(data: data, encoding: .utf8),
              let expected = text.split(whereSeparator: { $0 == " " || $0 == "\n" }).first.map(String.init),
              expected.count == 64 else {
            throw UpdateError.message(T("校验值读取失败"))
        }
        let handle = try FileHandle(forReadingFrom: dmg)
        defer { try? handle.close() }
        var hasher = SHA256()
        while let chunk = try handle.read(upToCount: 1 << 20), !chunk.isEmpty {
            hasher.update(data: chunk)
        }
        let actual = hasher.finalize().map { String(format: "%02x", $0) }.joined()
        guard actual == expected.lowercased() else {
            throw UpdateError.message(T("安装包校验不一致，已放弃更新"))
        }
    }

    private func stage(_ dmg: URL, release: GitHubRelease, bridgePid: Int?) async throws {
        let app = Bundle.main.bundleURL
        // 预览版的应用名是 AgentBridge-preview.app：查找、替换都按自己这一份来。
        let name = app.lastPathComponent
        let destination = app.deletingLastPathComponent()
        guard FileManager.default.isWritableFile(atPath: destination.path) else {
            throw UpdateError.message(TF("没有写入 %@ 的权限；先把 %@ 拖进「应用程序」再更新", destination.path, name))
        }

        let work = dmg.deletingLastPathComponent()
        let mount = work.appendingPathComponent("mnt", isDirectory: true)
        try FileManager.default.createDirectory(at: mount, withIntermediateDirectories: true)
        try await run("/usr/bin/hdiutil", ["attach", dmg.path, "-nobrowse", "-readonly", "-mountpoint", mount.path])
        // 预览版从 AgentBridge.app 改名成了 AgentBridge-preview.app：旧版本更新上来时
        // 按自己的名字找不到，就退回到挂载点里唯一的那份 .app。
        guard let source = Self.appInInstaller(mount, preferred: name) else {
            throw UpdateError.message(TF("安装包里没有 %@", name))
        }
        let staged = work.appendingPathComponent(source.lastPathComponent)
        do {
            try await run("/bin/cp", ["-R", source.path, staged.path])
        } catch {
            _ = try? await run("/usr/bin/hdiutil", ["detach", mount.path, "-quiet"])
            throw error
        }
        _ = try? await run("/usr/bin/hdiutil", ["detach", mount.path, "-quiet"])

        // 助手脚本：等 App 退出 → 停掉它启动的 Bridge → 换掉应用包 → 用新版本启动。
        let script = work.appendingPathComponent("apply.sh")
        let body = """
        #!/bin/sh
        set -eu
        app_pid="$1"
        bridge_pid="$2"
        source="$3"
        target="$4"
        # 应用改名时（AgentBridge.app → AgentBridge-preview.app）落到新名字上，别把
        # 新版本塞进旧目录名。
        name=$(basename "$source")
        if [ "$(basename "$target")" != "$name" ]; then
          target="$(dirname "$target")/$name"
        fi
        # 替换到一半失败时至少把当前装着的那份重新拉起来，别停在「App 已退出」。
        opened=0
        reopen() { [ "$opened" = "1" ] || open "$target" 2>/dev/null || true; }
        trap reopen EXIT
        while kill -0 "$app_pid" 2>/dev/null; do sleep 0.3; done
        if [ "$bridge_pid" != "0" ]; then
          kill "$bridge_pid" 2>/dev/null || true
          while kill -0 "$bridge_pid" 2>/dev/null; do sleep 0.2; done
        fi
        cp -R "$source" "$target.new"
        old="$target.old"
        rm -rf "$old"
        if [ -e "$target" ]; then mv "$target" "$old"; fi
        mv "$target.new" "$target"
        xattr -dr com.apple.quarantine "$target" 2>/dev/null || true
        rm -rf "$old"
        opened=1
        open "$target"
        """
        try body.write(to: script, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: script.path)

        let helper = Process()
        helper.executableURL = URL(fileURLWithPath: "/bin/sh")
        helper.arguments = [
            script.path,
            String(ProcessInfo.processInfo.processIdentifier),
            String(bridgePid ?? 0),
            staged.path,
            app.path,
        ]
        try helper.run()
        NSApp.terminate(nil)
    }

    /// 安装包里唯一的 .app；名字对得上时直接用，对不上（改过名）就退回唯一那一份。
    private static func appInInstaller(_ mount: URL, preferred name: String) -> URL? {
        let direct = mount.appendingPathComponent(name)
        if FileManager.default.fileExists(atPath: direct.path) { return direct }
        let entries = (try? FileManager.default.contentsOfDirectory(
            at: mount,
            includingPropertiesForKeys: nil
        )) ?? []
        let apps = entries.filter { $0.pathExtension == "app" }
        return apps.count == 1 ? apps[0] : nil
    }

    private func run(_ tool: String, _ arguments: [String]) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            let process = Process()
            process.executableURL = URL(fileURLWithPath: tool)
            process.arguments = arguments
            process.standardOutput = FileHandle.nullDevice
            process.standardError = FileHandle.nullDevice
            process.terminationHandler = { finished in
                if finished.terminationStatus == 0 {
                    continuation.resume()
                } else {
                    let name = URL(fileURLWithPath: tool).lastPathComponent
                    continuation.resume(throwing: UpdateError.message(TF("%@ 执行失败（%d）", name, finished.terminationStatus)))
                }
            }
            do {
                try process.run()
            } catch {
                continuation.resume(throwing: error)
            }
        }
    }
}
