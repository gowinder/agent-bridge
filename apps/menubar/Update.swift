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
    static let currentVersion =
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.0.0"

    private(set) var phase: Phase = .idle
    private(set) var available: GitHubRelease?
    private(set) var lastChecked: Date?
    private(set) var lastFailure: String?
    var onChange: (() -> Void)?

    /// preview 中继吃预发布，生产只吃正式版，和 DMG 的发布流程保持一致。
    private var isPreview: Bool {
        AdminClient.isPreviewRelay(AdminClient.relayHint ?? UserDefaults.standard.string(forKey: "relayUrl"))
    }

    var isBusy: Bool {
        switch phase {
        case .checking, .downloading, .installing: return true
        case .idle, .failed: return false
        }
    }

    var summary: String {
        switch phase {
        case .checking: return "正在检查更新…"
        case .downloading: return "正在下载 \(available?.tag ?? "新版本")…"
        case .installing: return "正在安装，安装完成后会自动重启"
        case .failed(let reason): return "更新失败：\(reason)"
        case .idle: return "当前版本 v\(Self.currentVersion)"
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
            available = releases.first { release in
                !release.draft && (isPreview || !release.prerelease)
                    && VersionOrder.isNewer(release.tag, than: Self.currentVersion)
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
            phase = .failed("这个版本没有 DMG 附件")
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
            throw UpdateError.message("发布地址无效")
        }
        var request = URLRequest(url: url)
        request.timeoutInterval = 15
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        request.setValue("AgentBridge-menubar", forHTTPHeaderField: "User-Agent")
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let status = (response as? HTTPURLResponse)?.statusCode else {
            throw UpdateError.message("发布接口没有响应")
        }
        guard status == 200 else { throw UpdateError.message("发布接口返回 \(status)") }
        return try JSONDecoder().decode([GitHubRelease].self, from: data)
    }

    private func download(_ asset: GitHubAsset, release: GitHubRelease, bridgePid: Int?) async {
        do {
            var request = URLRequest(url: URL(string: asset.url)!)
            request.timeoutInterval = 600
            request.setValue("AgentBridge-menubar", forHTTPHeaderField: "User-Agent")
            let (temporary, response) = try await URLSession.shared.download(for: request)
            guard let status = (response as? HTTPURLResponse)?.statusCode else {
                throw UpdateError.message("下载没有响应")
            }
            guard status == 200 else { throw UpdateError.message("下载失败（HTTP \(status)）") }

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
            throw UpdateError.message("校验值读取失败")
        }
        let handle = try FileHandle(forReadingFrom: dmg)
        defer { try? handle.close() }
        var hasher = SHA256()
        while let chunk = try handle.read(upToCount: 1 << 20), !chunk.isEmpty {
            hasher.update(data: chunk)
        }
        let actual = hasher.finalize().map { String(format: "%02x", $0) }.joined()
        guard actual == expected.lowercased() else {
            throw UpdateError.message("安装包校验不一致，已放弃更新")
        }
    }

    private func stage(_ dmg: URL, release: GitHubRelease, bridgePid: Int?) async throws {
        let app = Bundle.main.bundleURL
        let destination = app.deletingLastPathComponent()
        guard FileManager.default.isWritableFile(atPath: destination.path) else {
            throw UpdateError.message("没有写入 \(destination.path) 的权限；先把 AgentBridge.app 拖进「应用程序」再更新")
        }

        let work = dmg.deletingLastPathComponent()
        let mount = work.appendingPathComponent("mnt", isDirectory: true)
        try FileManager.default.createDirectory(at: mount, withIntermediateDirectories: true)
        try await run("/usr/bin/hdiutil", ["attach", dmg.path, "-nobrowse", "-readonly", "-mountpoint", mount.path])
        let source = mount.appendingPathComponent("AgentBridge.app")
        let staged = work.appendingPathComponent("AgentBridge.app")
        do {
            guard FileManager.default.fileExists(atPath: source.path) else {
                throw UpdateError.message("安装包里没有 AgentBridge.app")
            }
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
                    continuation.resume(throwing: UpdateError.message("\(name) 执行失败（\(finished.terminationStatus)）"))
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
