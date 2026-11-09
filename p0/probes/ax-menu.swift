// Press a menu bar item by title, then dump the window tree.
//   swiftc -O ax-menu.swift -o ~/bin/ax-menu
//   ~/bin/ax-menu <bundleId> <menuItemTitle> [dumpPath] [maxDepth]
import ApplicationServices
import AppKit

let args = CommandLine.arguments
guard args.count >= 3 else {
    print("usage: ax-menu <bundleId> <menuItemTitle> [dumpPath] [maxDepth]")
    exit(2)
}
let bundleId = args[1]
let title = args[2]
let dumpPath = args.count > 3 ? args[3] : ""
let maxDepth = args.count > 4 ? (Int(args[4]) ?? 40) : 40

guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first else {
    print("not running: \(bundleId)")
    exit(1)
}
let root = AXUIElementCreateApplication(app.processIdentifier)
print("AXManualAccessibility: \(AXUIElementSetAttributeValue(root, "AXManualAccessibility" as CFString, kCFBooleanTrue).rawValue)")

func attr(_ e: AXUIElement, _ a: String) -> CFTypeRef? {
    var v: CFTypeRef?
    guard AXUIElementCopyAttributeValue(e, a as CFString, &v) == .success else { return nil }
    return v
}
func str(_ e: AXUIElement, _ a: String) -> String {
    if let s = attr(e, a) as? String { return s }
    if let n = attr(e, a) as? NSNumber { return n.stringValue }
    return ""
}
func kids(_ e: AXUIElement) -> [AXUIElement] {
    (attr(e, kAXChildrenAttribute) as? [AXUIElement]) ?? []
}

@discardableResult
func walk(_ e: AXUIElement, _ depth: Int = 0, _ body: (AXUIElement, Int) -> Bool) -> Bool {
    if depth > maxDepth { return false }
    if body(e, depth) { return true }
    for c in kids(e) { if walk(c, depth + 1, body) { return true } }
    return false
}

func describe(_ e: AXUIElement, _ depth: Int) -> String {
    var line = String(repeating: "  ", count: depth) + str(e, kAXRoleAttribute)
    for (label, name) in [("title", kAXTitleAttribute), ("desc", kAXDescriptionAttribute),
                          ("value", kAXValueAttribute), ("id", "AXIdentifier")] {
        let v = str(e, name)
        if !v.isEmpty {
            let one = v.replacingOccurrences(of: "\n", with: "⏎")
            line += " \(label)=\"\(one.count > 120 ? String(one.prefix(120)) + "…" : one)\""
        }
    }
    return line
}

func dump(_ path: String) {
    var out: [String] = []
    walk(root) { e, d in out.append(describe(e, d)); return false }
    let text = out.joined(separator: "\n")
    if path.isEmpty { print(text) } else {
        try? text.write(toFile: path, atomically: true, encoding: .utf8)
        print("dump: \(path) nodes=\(out.count)")
    }
}

app.activate()
Thread.sleep(forTimeInterval: 0.8)

var target: AXUIElement?
walk(root) { e, _ in
    guard str(e, kAXRoleAttribute) == "AXMenuItem" else { return false }
    let t = str(e, kAXTitleAttribute)
    guard t == title else { return false }
    target = e
    return true
}
guard let item = target else {
    print("menu item not found: \(title)")
    dump(dumpPath)
    exit(3)
}
let r = AXUIElementPerformAction(item, kAXPressAction as CFString)
print("press \"\(title)\": \(r.rawValue) (0 = ok)")
Thread.sleep(forTimeInterval: 3.0)
var wins: [String] = []
walk(root) { e, _ in
    if str(e, kAXRoleAttribute) == "AXWindow" { wins.append(str(e, kAXTitleAttribute)) }
    return false
}
print("windows: \(wins)")
dump(dumpPath)
exit(0)
