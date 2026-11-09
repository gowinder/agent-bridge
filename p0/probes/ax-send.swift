// AX send probe: press a named button (e.g. "新聊天"), type into the composer,
// submit, then report whether the text landed. Run OUTSIDE the sandbox from a
// Terminal that already has Accessibility permission.
//   swiftc -O ax-send.swift -o ~/bin/ax-send
//   ~/bin/ax-send com.openai.codex 新聊天 "Bridge AX 通道测试：只回复 OK-AX" [dumpPath]
import ApplicationServices
import AppKit

let args = CommandLine.arguments
guard args.count >= 4 else {
    print("usage: ax-send <bundleId> <buttonTitle> <text> [dumpPath]")
    exit(2)
}
let bundleId = args[1]
let buttonTitle = args[2]
let text = args[3]
let dumpPath = args.count > 4 ? args[4] : ""

guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first else {
    print("not running: \(bundleId)")
    exit(1)
}
let root = AXUIElementCreateApplication(app.processIdentifier)
let rc = AXUIElementSetAttributeValue(root, "AXManualAccessibility" as CFString, kCFBooleanTrue)
print("AXManualAccessibility set: \(rc.rawValue)")

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
    if depth > 50 { return false }
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

func dumpTree() -> [String] {
    var out: [String] = []
    walk(root) { e, d in out.append(describe(e, d)); return false }
    return out
}

func webTitle() -> String {
    var t = ""
    walk(root) { e, _ in
        guard str(e, kAXRoleAttribute) == "AXWebArea" else { return false }
        let v = str(e, kAXTitleAttribute)
        if !v.isEmpty { t = v; return true }
        return false
    }
    return t
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
    print("clicked \"\(label)\" at \(Int(c.x)),\(Int(c.y))")
}

func pressReturn() {
    for down in [true, false] {
        if let ev = CGEvent(keyboardEventSource: nil, virtualKey: 36, keyDown: down) {
            ev.post(tap: .cghidEventTap)
        }
    }
}

let beforeTitle = webTitle()
print("webArea before=\"\(beforeTitle)\"")

// Electron only routes some toolbar presses when the app is frontmost.
app.activate()
Thread.sleep(forTimeInterval: 1.0)

let useCmdN = args.contains("--cmd-n")
let sendOnly = args.contains("--send-only")
let threadTitle = ProcessInfo.processInfo.environment["AX_THREAD"] ?? ""

// 1. open a new chat: Cmd+N when asked, else press the named button
var pressed = false
if sendOnly {
    pressed = true
} else if !threadTitle.isEmpty {
    // select an existing conversation from the sidebar with a real click
    var found = false
    walk(root) { e, _ in
        guard str(e, kAXRoleAttribute) == "AXButton" else { return false }
        let t = str(e, kAXTitleAttribute), d = str(e, kAXDescriptionAttribute)
        guard t == threadTitle || d == threadTitle else { return false }
        click(e, threadTitle)
        found = true
        return true
    }
    guard found else {
        print("thread button not found: \(threadTitle)")
        exit(6)
    }
    pressed = true
} else if useCmdN {
    for down in [true, false] {
        if let ev = CGEvent(keyboardEventSource: nil, virtualKey: 45, keyDown: down) {
            ev.flags = .maskCommand
            ev.post(tap: .cghidEventTap)
        }
    }
    print("posted Cmd+N")
    pressed = true
} else {
    walk(root) { e, _ in
        guard str(e, kAXRoleAttribute) == "AXButton" else { return false }
        let t = str(e, kAXTitleAttribute), d = str(e, kAXDescriptionAttribute)
        guard t == buttonTitle || d == buttonTitle else { return false }
        let r = AXUIElementPerformAction(e, kAXPressAction as CFString)
        print("press \"\(buttonTitle)\": \(r.rawValue) (0 = ok)")
        pressed = r == .success
        return true
    }
}
guard pressed else {
    print("button not found: \(buttonTitle)")
    if !dumpPath.isEmpty { try? dumpTree().joined(separator: "\n").write(toFile: dumpPath, atomically: true, encoding: .utf8) }
    exit(3)
}
Thread.sleep(forTimeInterval: 2.5)

// safety: if the view did not change, we might be typing into an existing conversation
let afterTitle = webTitle()
print("webArea after=\"\(afterTitle)\"")
if !threadTitle.isEmpty && !afterTitle.contains(threadTitle) {
    print("ABORT: view \"\(afterTitle)\" does not match thread \"\(threadTitle)\", not typing")
    if !dumpPath.isEmpty { try? dumpTree().joined(separator: "\n").write(toFile: dumpPath, atomically: true, encoding: .utf8) }
    exit(7)
}

if !sendOnly && threadTitle.isEmpty && !beforeTitle.isEmpty && beforeTitle == afterTitle {
    print("ABORT: view unchanged after pressing \"\(buttonTitle)\", not typing")
    if !dumpPath.isEmpty { try? dumpTree().joined(separator: "\n").write(toFile: dumpPath, atomically: true, encoding: .utf8) }
    exit(5)
}

// 2. locate the composer (prefer one whose desc mentions "Codex")
var composer: AXUIElement?
var fallback: AXUIElement?
walk(root) { e, _ in
    guard str(e, kAXRoleAttribute) == "AXTextArea" else { return false }
    let d = str(e, kAXDescriptionAttribute)
    if fallback == nil { fallback = e }
    if d.contains("Codex") { composer = e; return true }
    return false
}
if composer == nil { composer = fallback }
guard let ta = composer else {
    print("no AXTextArea found")
    if !dumpPath.isEmpty { try? dumpTree().joined(separator: "\n").write(toFile: dumpPath, atomically: true, encoding: .utf8) }
    exit(4)
}
print("composer desc=\"\(str(ta, kAXDescriptionAttribute))\" title=\"\(str(ta, kAXTitleAttribute))\"")

// 3. set the text and submit
let set = AXUIElementSetAttributeValue(ta, kAXValueAttribute as CFString, text as CFString)
print("set value: \(set.rawValue)")
_ = AXUIElementSetAttributeValue(ta, kAXFocusedAttribute as CFString, kCFBooleanTrue)
Thread.sleep(forTimeInterval: 0.4)
// AXConfirm and AXPress are no-ops in this app; use a real Return key, then a real click.
pressReturn()
Thread.sleep(forTimeInterval: 2.0)
var stillText = str(ta, kAXValueAttribute)
if stillText.trimmingCharacters(in: .whitespacesAndNewlines).count > 3 {
    var clicked = false
    for label in ["发送", "Send", "Submit"] {
        if clicked { break }
        walk(root) { e, _ in
            guard str(e, kAXRoleAttribute) == "AXButton" else { return false }
            let t = str(e, kAXTitleAttribute), d = str(e, kAXDescriptionAttribute)
            guard t == label || d == label else { return false }
            click(e, label)
            clicked = true
            return true
        }
    }
    Thread.sleep(forTimeInterval: 2.0)
    stillText = str(ta, kAXValueAttribute)
}
print("composer after submit=\"\(stillText.replacingOccurrences(of: "\n", with: "⏎"))\"")

// 4. wait, then report
Thread.sleep(forTimeInterval: 14)
let tree = dumpTree()
if !dumpPath.isEmpty {
    try? tree.joined(separator: "\n").write(toFile: dumpPath, atomically: true, encoding: .utf8)
    print("dump: \(dumpPath) nodes=\(tree.count)")
}
let hit = tree.filter { $0.contains("OK-AX") || $0.contains("Bridge AX") }
print("--- matches \(hit.count) ---")
for line in hit.prefix(20) { print(line) }
let title = walk(root) { e, _ in
    let t = str(e, kAXRoleAttribute) == "AXWebArea" ? str(e, kAXTitleAttribute) : ""
    if !t.isEmpty { print("webArea title=\"\(t)\""); return true }
    return false
}
_ = title
exit(0)
