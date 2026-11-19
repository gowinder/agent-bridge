import Foundation

/// 菜单栏的多语言文案。中文原文就是字典的键：`T("刷新")` 按当前语言查
/// `L10nTables`，查不到先回落英文再回落中文，所以漏翻只是显示中文，不会崩。
///
/// 语言来源按顺序取：`UserDefaults` 的 `uiLanguage`（菜单里的「语言」子菜单会写它）
/// → 系统首选语言。系统语言不在支持列表里时用英文。
enum L10n {
    static let defaultsKey = "uiLanguage"

    /// 支持的界面语言。`rawValue` 就是写进 `UserDefaults` 的值。
    enum Lang: String, CaseIterable {
        case zh, en, ja, ko, es, fr, de, pt

        /// 语言菜单里的自称：用户总能认出自己那一条。
        var label: String {
            switch self {
            case .zh: return "中文"
            case .en: return "English"
            case .ja: return "日本語"
            case .ko: return "한국어"
            case .es: return "Español"
            case .fr: return "Français"
            case .de: return "Deutsch"
            case .pt: return "Português"
            }
        }

        /// 中文是源语言，直接返回原文，没有表。
        var table: [String: String]? {
            switch self {
            case .zh: return nil
            case .en: return L10nTables.en
            case .ja: return L10nTables.ja
            case .ko: return L10nTables.ko
            case .es: return L10nTables.es
            case .fr: return L10nTables.fr
            case .de: return L10nTables.de
            case .pt: return L10nTables.pt
            }
        }
    }

    /// 用户明确选过的语言；`nil` 表示跟随系统。
    static var stored: Lang? {
        guard let raw = UserDefaults.standard.string(forKey: defaultsKey) else { return nil }
        return Lang(rawValue: raw)
    }

    /// 系统首选语言，按主标签匹配（`ja-JP`、`ja` 都算日文）。
    static var system: Lang {
        let preferred = Locale.preferredLanguages.first ?? "en"
        let base = preferred.split(separator: "-").first.map(String.init) ?? preferred
        if let lang = Lang(rawValue: base) { return lang }
        // 繁体中文也先给简体文案，总比整页英文好读。
        if preferred.hasPrefix("zh") { return .zh }
        return .en
    }

    static var current: Lang { stored ?? system }

    /// `nil` 表示回到跟随系统。
    static func set(_ lang: Lang?) {
        if let lang {
            UserDefaults.standard.set(lang.rawValue, forKey: defaultsKey)
        } else {
            UserDefaults.standard.removeObject(forKey: defaultsKey)
        }
    }

    static func t(_ zh: String) -> String {
        let lang = current
        guard lang != .zh else { return zh }
        if let hit = lang.table?[zh] { return hit }
        return L10nTables.en[zh] ?? zh
    }
}

/// 短名字，源码里到处都是。
func T(_ zh: String) -> String {
    L10n.t(zh)
}

/// 带占位符的版本：字典里写 `%@` / `%d`，和 `String(format:)` 一致。
func TF(_ zh: String, _ args: CVarArg...) -> String {
    String(format: L10n.t(zh), arguments: args)
}
