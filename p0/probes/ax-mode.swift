// Switch the Claude desktop app to a surface (chat/cowork/code) by clicking the
// unnamed Chat item or a named Cowork/Code button in the "Mode" group, then dump.
//   swiftc -O ax-mode.swift -o ~/bin/ax-mode
//   ~/bin/ax-mode <bundleId> <chat|Cowork|Code> [dumpPath] [maxDepth]
import ApplicationServices
import AppKit

let args = CommandLine.arguments
guard args.count >= 3 else {
    print("usage: ax-mode <bundleId> <chat|Cowork|Code> [dumpPath] [maxDepth]")
    exit(2)
}
let bundleId = args[1]
let wanted = args[2]
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
func frame(_ e: AXUIElement) -> CGRect? {
    guard let pv = attr(e, kAXPositionAttribute), let sv = attr(e, kAXSizeAttribute) else { return nil }
    var p = CGPoint.zero, s = CGSize.zero
    guard AXValueGetValue(pv as! AXValue, .cgPoint, &p), AXValueGetValue(sv as! AXValue, .cgSize, &s) else { return nil }
    return CGRect(origin: p, size: s)
}
func click(_ e: AXUIElement, _ label: String) {
    guard let f = frame(e) else { print("click \"\(label)\": no frame"); return }
    let c = CGPoint(x: f.midX, y: f.midY)
    let src = CGEventSource(stateID: .hidSystemState)
    CGEvent(mouseEventSource: src, mouseType: .mouseMoved, mouseCursorPosition: c, mouseButton: .left)?.post(tap: .cghidEventTap)
    Thread.sleep(forTimeInterval: 0.1)
    CGEvent(mouseEventSource: src, mouseType: .leftMouseDown, mouseCursorPosition: c, mouseButton: .left)?.post(tap: .cghidEventTap)
    Thread.sleep(forTimeInterval: 0.05)
    CGEvent(mouseEventSource: src, mouseType: .leftMouseUp, mouseCursorPosition: c, mouseButton: .left)?.post(tap: .cghidEventTap)
    print("clicked \"\(label)\" at \(Int(c.x)),\(Int(c.y)) size=\(Int(f.width))x\(Int(f.height))")
}
func webTitles() -> [String] {
    var t: [String] = []
    walk(root) { e, _ in
        if str(e, kAXRoleAttribute) == "AXWebArea" {
            let v = str(e, kAXTitleAttribute)
            if !v.isEmpty { t.append(v) }
        }
        return false
    }
    return t
}

app.activate()
Thread.sleep(forTimeInterval: 1.0)
print("webAreas before: \(webTitles())")

// locate the Mode group, then its children
var modeGroup: AXUIElement?
walk(root) { e, _ in
    guard str(e, kAXRoleAttribute) == "AXGroup", str(e, kAXDescriptionAttribute) == "Mode" else { return false }
    modeGroup = e
    return true
}
guard let group = modeGroup else {
    print("Mode group not found")
    dump(dumpPath)
    exit(3)
}
let items = kids(group)
var itemDesc: [String] = []
for it in items {
    let f = frame(it).map { "@\(Int($0.minX)),\(Int($0.minY)) \(Int($0.width))x\(Int($0.height))" } ?? "@?"
    itemDesc.append("\(str(it, kAXRoleAttribute)) t=\(str(it, kAXTitleAttribute)) d=\(str(it, kAXDescriptionAttribute)) \(f)")
}
print("mode items: \(itemDesc)")

var hit = false
for item in items {
    let t = str(item, kAXTitleAttribute), d = str(item, kAXDescriptionAttribute)
    if wanted == "chat" {
        // the Chat entry has no accessible name (icon-only)
        let role = str(item, kAXRoleAttribute)
        if role == "AXGroup" && t.isEmpty && d.isEmpty {
            click(item, "chat(unnamed)")
            hit = true
            break
        }
    } else if t == wanted || d == wanted || d.hasPrefix(wanted + ",") {
        click(item, wanted)
        hit = true
        break
    }
}
if !hit {
    print("mode item not found: \(wanted)")
    dump(dumpPath)
    exit(4)
}
Thread.sleep(forTimeInterval: 4.0)
print("webAreas after: \(webTitles())")
dump(dumpPath)
exit(0)
