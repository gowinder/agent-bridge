// Dump the Accessibility tree of a running app. Run OUTSIDE the sandbox, after
// granting Accessibility permission to the built binary.
//   swiftc -O ax-dump.swift -o ~/bin/ax-dump
//   ~/bin/ax-dump com.openai.codex 6 800
import ApplicationServices
import AppKit

let args = CommandLine.arguments
guard args.count > 1 else {
    print("usage: ax-dump <bundleId> [maxDepth=6] [maxNodes=800]")
    exit(2)
}
let bundleId = args[1]
let maxDepth = args.count > 2 ? (Int(args[2]) ?? 6) : 6
let maxNodes = args.count > 3 ? (Int(args[3]) ?? 800) : 800

guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first else {
    print("not running: \(bundleId)")
    exit(1)
}

let root = AXUIElementCreateApplication(app.processIdentifier)

// Electron/Chromium only builds its web-content AX tree when asked.
let rc = AXUIElementSetAttributeValue(root, "AXManualAccessibility" as CFString, kCFBooleanTrue)
print("AXManualAccessibility set: \(rc.rawValue)  (0 = ok)")

func attr(_ e: AXUIElement, _ a: String, _ max: Int = 70) -> String {
    var v: CFTypeRef?
    guard AXUIElementCopyAttributeValue(e, a as CFString, &v) == .success, let v else { return "" }
    let s: String
    if let x = v as? String { s = x }
    else if let x = v as? NSNumber { s = x.stringValue }
    else if let x = v as? [AXUIElement] { s = "<\(x.count) children>" }
    else { return "" }
    return s.count > max ? String(s.prefix(max)) + "…" : s
}

func kids(_ e: AXUIElement) -> [AXUIElement] {
    var v: CFTypeRef?
    guard AXUIElementCopyAttributeValue(e, kAXChildrenAttribute as CFString, &v) == .success else { return [] }
    return (v as? [AXUIElement]) ?? []
}

var visited = 0
var truncated = false

func dump(_ e: AXUIElement, _ depth: Int) {
    guard visited < maxNodes else { truncated = true; return }
    visited += 1
    let role = attr(e, kAXRoleAttribute, 30)
    var line = String(repeating: "  ", count: depth) + role
    for (label, name) in [("title", kAXTitleAttribute), ("desc", kAXDescriptionAttribute),
                          ("value", kAXValueAttribute), ("id", "AXIdentifier")] {
        let v = attr(e, name)
        if !v.isEmpty { line += " \(label)=\"\(v)\"" }
    }
    print(line)
    if depth < maxDepth { for c in kids(e) { dump(c, depth + 1) } }
}

dump(root, 0)
print("--- nodes=\(visited)\(truncated ? " (truncated at \(maxNodes))" : "") ---")
