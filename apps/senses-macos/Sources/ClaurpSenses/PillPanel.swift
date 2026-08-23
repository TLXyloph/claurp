import AppKit
import SwiftUI
import ClaurpSensesCore

final class PillPanel: NSPanel {
    private let hosting: NSHostingView<PillView>

    init(store: HudStore, respond: @escaping (HudPermission, PermissionDecision) -> Void) {
        hosting = NSHostingView(rootView: PillView(store: store, respond: respond))
        super.init(contentRect: NSRect(x: 0, y: 0, width: 360, height: 64),
                   styleMask: [.nonactivatingPanel, .borderless, .fullSizeContentView],
                   backing: .buffered, defer: false)
        isFloatingPanel = true
        level = .floating
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        isMovableByWindowBackground = true
        backgroundColor = .clear
        isOpaque = false
        hasShadow = true
        contentView = hosting
        setFrameAutosaveName("ClaurpPill")
        if frameAutosaveName.isEmpty || !setFrameUsingName("ClaurpPill") {
            positionTopRight()
        }
    }

    func refreshSize() {
        setContentSize(hosting.fittingSize)
    }

    private func positionTopRight() {
        guard let screen = NSScreen.main else { return }
        let f = screen.visibleFrame
        setFrameOrigin(NSPoint(x: f.maxX - frame.width - 24, y: f.maxY - frame.height - 24))
    }
}
