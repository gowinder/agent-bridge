// Accessibility probe: run OUTSIDE the sandbox and after granting Accessibility
// permission to the built binary (System Settings -> Privacy & Security -> Accessibility).
//   swiftc -O ax-probe.swift -o ax-probe && ./ax-probe
import ApplicationServices
import AppKit

func err(_ e: AXError) -> String { "\(e.rawValue)" }

print("AXIsProcessTrusted:", AXIsProcessTrusted())
let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: false] as CFDictionary
print("AXIsProcessTrustedWithOptions:", AXIsProcessTrustedWithOptions(opts))

for (name, bundleId) in [("ChatGPT", "com.openai.codex"),
                         ("Claude", "com.anthropic.claudefordesktop")] {
    guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first else {
        print("\(name): not running")
        continue
    }
    let ax = AXUIElementCreateApplication(app.processIdentifier)
    var windows: CFTypeRef?
    let ew = AXUIElementCopyAttributeValue(ax, kAXWindowsAttribute as CFString, &windows)
    var title: CFTypeRef?
    let et = AXUIElementCopyAttributeValue(ax, kAXTitleAttribute as CFString, &title)
    let count = (windows as? [AXUIElement])?.count ?? -1
    print("\(name) pid=\(app.processIdentifier) windows=\(err(ew))(n=\(count)) title=\(err(et))=\(title.map { String(describing: $0) } ?? "nil")")

    if ew == .success, let list = windows as? [AXUIElement], let first = list.first {
        var children: CFTypeRef?
        let ec = AXUIElementCopyAttributeValue(first, kAXChildrenAttribute as CFString, &children)
        print("  first window children=\(err(ec))(n=\((children as? [AXUIElement])?.count ?? -1))")
    }
}
