import Foundation

/// 菜单栏的中英双语。中文原文就是字典的键：`T("刷新")` 在英文环境下查
/// `en` 表，查不到就原样返回中文，所以漏翻只是显示中文，不会崩。
///
/// 语言来源按顺序取：`UserDefaults` 的 `uiLanguage`（菜单里的「语言」一项会写它）
/// → 系统首选语言。系统是中文就继续用中文，其它语言一律英文。
enum L10n {
    static let defaultsKey = "uiLanguage"

    static var stored: String? {
        let value = UserDefaults.standard.string(forKey: defaultsKey) ?? ""
        return value == "zh" || value == "en" ? value : nil
    }

    static var isEnglish: Bool {
        if let stored { return stored == "en" }
        let preferred = Locale.preferredLanguages.first ?? "en"
        return !preferred.hasPrefix("zh")
    }

    static func set(_ language: String?) {
        if let language {
            UserDefaults.standard.set(language, forKey: defaultsKey)
        } else {
            UserDefaults.standard.removeObject(forKey: defaultsKey)
        }
    }

    static func t(_ zh: String) -> String {
        guard isEnglish else { return zh }
        return en[zh] ?? zh
    }

    private static let en: [String: String] = [
        "端口必须在 1024–65535 之间": "Port must be between 1024 and 65535",
        "管理接口地址无效": "Invalid admin endpoint",
        "邀请响应无法解析": "Could not parse the invite response",
        "命令超时": "Command timed out",
        "从未连接": "Never connected",
        "刚刚": "just now",
        "状态目录": "State folder",
        "Bridge 未运行": "Bridge is not running",
        "Bridge 尚未初始化": "Bridge is not set up yet",
        "启动 Bridge": "Start Bridge",
        "停止 Bridge": "Stop Bridge",
        "打开日志": "Open log",
        "初始化 Bridge…": "Set up Bridge…",
        "设定…": "Settings…",
        "刷新": "Refresh",
        "退出": "Quit",
        "在线": "online",
        "离线": "offline",
        "还没有配对过设备": "No paired devices yet",
        "已作废": "revoked",
        "已过期": "expired",
        "断开连接": "Disconnect",
        "作废证书…": "Revoke certificate…",
        "断开全部连接": "Disconnect all",
        "作废全部证书…": "Revoke all certificates…",
        "删除全部作废的设备…": "Remove all revoked devices…",
        "邀请新设备…": "Invite a new device…",
        "文件浏览（只读，仅当前项目目录）": "File browsing (read-only, current project folder only)",
        "开启 1 小时": "Turn on for 1 hour",
        "开启 8 小时": "Turn on for 8 hours",
        "开启 24 小时": "Turn on for 24 hours",
        "关闭": "Off",
        "命令执行（可写，可访问整台机器）": "Command execution (writable, whole machine)",
        "在浏览器中打开": "Open in browser",
        "远程工具：已关闭": "Remote tools: off",
        "文件": "Files",
        "命令": "Commands",
        "已开启": "on",
        "检查更新…": "Check for updates…",
        "最近操作日志": "Recent activity",
        "暂无操作记录": "No activity yet",
        "立即更新": "Update now",
        "稍后": "Later",
        "会下载安装包并替换当前应用，完成后自动重启。由菜单栏启动的 Bridge 会跟着重启。":
            "This downloads the update and replaces the app, then restarts it. A Bridge started from the menu bar restarts with it.",
        "更新": "Update",
        "取消": "Cancel",
        "断开失败": "Disconnect failed",
        "作废后这个设备无法再连接，需要重新配对才能使用。":
            "Once revoked, this device can no longer connect; it has to be paired again.",
        "作废": "Revoke",
        "作废失败": "Revoke failed",
        "作废后这些设备都无法再连接，需要重新配对才能使用。":
            "Once revoked, these devices can no longer connect; they have to be paired again.",
        "全部作废": "Revoke all",
        "部分设备作废失败": "Some devices could not be revoked",
        "生成邀请失败": "Could not create the invite",
        "设置远程工具失败": "Could not change remote tools",
        "邀请新设备": "Invite a new device",
        "用手机相机扫码打开配对页，或复制链接到浏览器。链接 5 分钟内有效；客户端显示的确认码要和下面一致，否则取消配对。":
            "Scan the code with your phone camera, or copy the link into a browser. The link is valid for 5 minutes; the code shown on the client must match the one below, otherwise pairing is cancelled.",
        "等待设备打开链接…": "Waiting for the device to open the link…",
        "复制链接": "Copy link",
        "核对这个确认码与客户端显示的是否一致": "Check that this code matches the one on the client",
        "等待握手…": "Waiting for the handshake…",
        "设备已连接，正在建立加密通道…": "Device connected, setting up the encrypted channel…",
        "配对完成": "Paired",
        "配对已取消或连接中断": "Pairing cancelled or the connection dropped",
        "已配对": "paired",
        "已结束": "finished",
        "还没有日志": "No log yet",
        "会把它们从本机和中继的设备清单里彻底删掉（连同操作日志），无法恢复。证书本来就已经作废，删除只是清理列表。":
            "This removes them from this Mac and from the relay's device list, along with their activity log. It cannot be undone; the certificates are already revoked, this only cleans up the list.",
        "删除": "Remove",
        "部分设备删除失败": "Some devices could not be removed",
        "删除失败": "Remove failed",
        "常规": "General",
        "日志": "Log",
        "连接": "Connection",
        "中继": "Relay",
        "房间号": "Room",
        "管理端口": "Admin port",
        "本机接口": "Local endpoint",
        "修改…": "Change…",
        "托管会话": "Hosted sessions",
        "允许 bypassPermissions（跳过权限确认）": "Allow bypassPermissions (skip permission prompts)",
        "打开后网页可以给托管会话选 bypassPermissions，不再逐条询问权限。只在你信任远端操作时打开。":
            "When on, the web client can pick bypassPermissions for hosted sessions and stop asking per action. Only turn this on if you trust remote actions.",
        "托管目录": "Hosted folders",
        "空闲超时": "Idle timeout",
        "远程工具": "Remote tools",
        "到期前 30 分钟提醒": "Notify 30 minutes before expiry",
        "开关立即生效；菜单里的「开启 1 / 8 / 24 小时」只是加个自动关闭的时限。勾选提醒后，自动关闭前 30 分钟会发一条系统通知。":
            "Toggles apply immediately; the 1 / 8 / 24 hour items in the menu only add an auto-off timer. With notifications on, you get one 30 minutes before it turns off automatically.",
        "自动更新（每 10 分钟检查，有新版本直接装）": "Automatic updates (check every 10 minutes, install right away)",
        "装着新版本时会替换 AgentBridge.app 并自动重启，由菜单栏启动的 Bridge 跟着重启；正在配对时跳过。关掉后只在菜单里手动检查。":
            "When an update is found it replaces AgentBridge.app and restarts, taking a menu-bar-started Bridge with it; skipped while pairing. With this off, updates are only checked from the menu.",
        "按设备、工程、agent 或内容过滤": "Filter by device, project, agent or content",
        "时间": "Time",
        "来自": "From",
        "工程": "Project",
        "标题与正文": "Title and body",
        "还没有收到客户端发来的消息": "No messages from clients yet",
        "（环境变量指定）": " (set by environment)",
        "（没有可用的托管目录）": "(no hosted folders available)",
        "读取中…": "Reading…",
        "Bridge 未运行，无法读取": "Bridge is not running, nothing to read",
        "没有匹配的消息": "No matching messages",
        "保存失败": "Save failed",
        "文件浏览": "File browsing",
        "命令执行": "Command execution",
        "远程工具即将关闭": "Remote tools are about to turn off",
        "选中继地址即可：房间号和凭据都在本机生成，中继只负责转发。":
            "Picking a relay is all it takes: the room and the keys are generated on this Mac, the relay only forwards.",
        "初始化": "Set up",
        "中继地址": "Relay URL",
        "本机名称": "Device name",
        "信息不完整": "Incomplete",
        "中继地址必须填写。": "The relay URL is required.",
        "无法运行 Bridge": "Cannot run Bridge",
        "找不到 node 或 apps/bridge/dist/main.js。": "Cannot find node or apps/bridge/dist/main.js.",
        "初始化失败": "Setup failed",
        "已有 Bridge 在运行": "A Bridge is already running",
        "找不到 node": "Cannot find node",
        "设置环境变量 AGENT_BRIDGE_NODE 指向 node 可执行文件。":
            "Point the AGENT_BRIDGE_NODE environment variable at the node executable.",
        "找不到 Bridge": "Cannot find Bridge",
        "设置环境变量 AGENT_BRIDGE_BIN 指向 apps/bridge/dist/main.js。":
            "Point the AGENT_BRIDGE_BIN environment variable at apps/bridge/dist/main.js.",
        "启动失败": "Start failed",
        "Bridge 启动失败": "Bridge failed to start",
        "本地管理接口只监听 127.0.0.1。preview 默认 47826，生产默认 47825；留空恢复按中继环境取默认值。保存后会重启菜单栏启动的 Bridge。":
            "The local admin endpoint only listens on 127.0.0.1. Preview defaults to 47826, production to 47825; leave it blank to follow the relay. Saving restarts a menu-bar-started Bridge.",
        "保存": "Save",
        "1024–65535，留空用默认": "1024–65535, blank for the default",
        "环境变量优先": "Environment wins",
        "当前设置了 AGENT_BRIDGE_ADMIN_PORT，菜单里保存的端口不会生效；删掉该环境变量并重开 App。":
            "AGENT_BRIDGE_ADMIN_PORT is set, so a port saved here has no effect; remove that variable and reopen the app.",
        "端口不合法": "Invalid port",
        "请填 1024–65535 之间的整数，或留空恢复默认。":
            "Enter an integer between 1024 and 65535, or leave it blank for the default.",
        "保存端口失败": "Could not save the port",
        "端口已保存": "Port saved",
        "（没有更多信息）": "(no further details)",
        "好": "OK",
        "管理接口返回 %d：%@": "Admin API returned %d: %@",
        "Bridge 还没启动过，找不到管理令牌（%@）": "Bridge has never started, so there is no admin token (%@)",
        "管理令牌为空：%@": "The admin token is empty: %@",
        "Bridge 未响应（127.0.0.1:%d）": "Bridge is not responding (127.0.0.1:%d)",
        "%d 分钟前": "%d min ago",
        "%d 小时前": "%d h ago",
        "%d 天前": "%d d ago",
        " · 可更新 %@": " · update %@ available",
        "%d 个客户端已连接": "%d clients connected",
        " · 就绪": " · ready",
        "未运行": "not running",
        "尚未初始化": "not set up",
        "管理端口 %d 被另一份 Bridge 占用": "Admin port %d is taken by another Bridge",
        "状态目录：%@": "State folder: %@",
        "管理端口…（%d）": "Admin port… (%d)",
        "设备列表读取失败：%@": "Could not read the device list: %@",
        "当前连接 %d 条": "%d active connections",
        "管理端口：%d…": "Admin port: %d…",
        "远程工具：%@ 已开启": "Remote tools: %@ on",
        "发现新版本 %@ — 立即更新": "Version %@ available — update now",
        "上次更新失败：%@": "Last update failed: %@",
        "菜单栏 app v%@ · %@": "Menu bar app v%@ · %@",
        "预览版": "preview",
        "正式版": "release",
        "检查更新失败：%@": "Update check failed: %@",
        "更多…（共 %d 条）": "More… (%d)",
        "发现新版本 %@": "Version %@ available",
        "菜单栏 app 当前 v%@。点「立即更新」会下载 DMG、替换应用，完成后自动重启。":
            "The menu bar app is on v%@. Update now downloads the DMG, replaces the app and restarts it.",
        "更新到 %@？": "Update to %@?",
        "作废「%@」的证书？": "Revoke the certificate for \"%@\"?",
        "作废全部 %d 个设备的证书？": "Revoke the certificates for all %d devices?",
        "Bridge 未响应：%@": "Bridge is not responding: %@",
        "Bridge 启动后日志会写到：%@": "Once Bridge starts, the log is written to: %@",
        "删除全部 %d 个作废的设备？": "Remove all %d revoked devices?",
        "设定": "Settings",
        "%d 分钟": "%d min",
        "%d 条": "%d",
        "%@将在 %d 分钟后自动关闭；需要继续用就在菜单里重新开启。":
            "%@ turns off in %d minutes; turn it back on from the menu if you still need it.",
        "127.0.0.1:%d 已被占用，通常是另一份状态目录的 Bridge（例如终端里用 AGENT_BRIDGE_HOME 启动的 preview 实例）。先停掉它，或在菜单「管理端口」里换一个端口。":
            "127.0.0.1:%d is already in use, usually by a Bridge from another state folder (for example a preview instance started with AGENT_BRIDGE_HOME). Stop that one, or pick another port under Admin port in the menu.",
        "进程已退出（代码 %d）": "The process exited (code %d)",
        "当前运行的 Bridge 不是菜单栏启动的，需要手动重启后才会监听 127.0.0.1:%d。":
            "The running Bridge was not started from the menu bar; restart it by hand so it listens on 127.0.0.1:%d.",
        "(未找到)": "(not found)",
        "initialized=unknown（info 无法运行）": "initialized=unknown (info did not run)",
        "语言：中文": "Language: English",
        "只更新预览版，正式版不提示（设定里可勾选升级到正式版）": "Only preview builds are offered; stable releases are not announced (opt in from Settings)",
        "有新版本直接下载替换并重启，正在配对时跳过；关掉后只在菜单手动检查。": "New versions are downloaded, swapped in and restarted automatically; skipped while pairing. When off, you check by hand from the menu.",
        "允许升级到正式版（默认关，只升 rc）": "Allow upgrades to stable releases (off by default: rc only)",
        "装在预览版 v%@：关着只升 rc；勾选后正式版也会提示并安装。": "Installed preview v%@: while off, only rc builds arrive; when checked, stable releases are offered and installed too.",
        "正在检查更新…": "Checking for updates…",
        "新版本": "New version",
        "正在安装，安装完成后会自动重启": "Installing; the app restarts when it is done",
        "这个版本没有 DMG 附件": "This release has no DMG asset",
        "发布地址无效": "The release URL is invalid",
        "发布接口没有响应": "The release API did not respond",
        "下载没有响应": "The download did not respond",
        "校验值读取失败": "Could not read the checksum",
        "安装包校验不一致，已放弃更新": "Checksum mismatch on the installer, update aborted",
        "安装包里没有 AgentBridge.app": "The installer does not contain AgentBridge.app",
        "正在下载 %@…": "Downloading %@…",
        "更新失败：%@": "Update failed: %@",
        "发布接口返回 %d": "The release API returned %d",
        "下载失败（HTTP %d）": "Download failed (HTTP %d)",
        "没有写入 %@ 的权限；先把 AgentBridge.app 拖进「应用程序」再更新": "No permission to write to %@; move AgentBridge.app into Applications first, then update",
        "%@ 执行失败（%d）": "%@ failed (exit code %d)",
    ]
}

/// 短名字，源码里到处都是。
func T(_ zh: String) -> String {
    L10n.t(zh)
}

/// 带占位符的版本：字典里写 `%@` / `%d`，和 `String(format:)` 一致。
func TF(_ zh: String, _ args: CVarArg...) -> String {
    String(format: L10n.t(zh), arguments: args)
}
