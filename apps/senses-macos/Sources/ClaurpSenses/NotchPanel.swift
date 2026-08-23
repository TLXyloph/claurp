import AppKit
import SwiftUI
import ClaurpSensesCore

/// Top-center drop-down that visually extends the MacBook notch: flush with
/// the screen's top edge, non-draggable, and animates open/closed rather
/// than simply appearing/disappearing (spec §4.2).
final class NotchPanel: NSPanel {
    private let hosting: NSHostingView<NotchView>
    private var isShown = false

    /// Guards against animation races — e.g. a show() arriving while a
    /// hide() animation is still in flight. Each show()/hide() call stamps
    /// the current generation; a completion handler only acts if its
    /// generation is still the latest one issued, so a hide() superseded by
    /// a later show() becomes a no-op instead of order-out-ing a panel the
    /// caller just asked to re-show.
    private var generation = 0

    init(store: HudStore,
         levelStore: MicLevelStore,
         respond: @escaping (HudPermission, PermissionDecision) -> Void) {
        let screen = NSScreen.main
        let width = Self.panelWidth(for: screen)
        let topInset = screen?.safeAreaInsets.top ?? 0
        hosting = NSHostingView(rootView: NotchView(store: store,
                                                     levelStore: levelStore,
                                                     width: width,
                                                     topInset: topInset,
                                                     respond: respond))
        super.init(contentRect: NSRect(x: 0, y: 0, width: width, height: max(topInset, 1)),
                   styleMask: [.nonactivatingPanel, .borderless, .fullSizeContentView],
                   backing: .buffered, defer: false)
        isFloatingPanel = true
        level = .statusBar
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        backgroundColor = .clear
        isOpaque = false
        hasShadow = true
        contentView = hosting
        setFrame(Self.collapsedFrame(width: width, screen: screen), display: false)
    }

    /// Shows the panel (animating up from the collapsed/notch-only state),
    /// or — if already shown — re-measures the SwiftUI content and animates
    /// to the new height, top edge staying pinned to the screen's top edge.
    func show() {
        generation += 1
        let screen = NSScreen.main
        let width = Self.panelWidth(for: screen)
        let target = Self.targetFrame(width: width, contentHeight: hosting.fittingSize.height, screen: screen)
        if !isShown {
            setFrame(Self.collapsedFrame(width: width, screen: screen), display: false)
            orderFrontRegardless()
            isShown = true
        }
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.30
            context.timingFunction = CAMediaTimingFunction(name: .easeOut)
            self.animator().setFrame(target, display: true)
        }
    }

    /// Animates back to the collapsed (notch-only) frame, then orders the
    /// panel out entirely once the animation completes.
    func hide() {
        guard isShown else { return }
        generation += 1
        let myGeneration = generation
        let screen = NSScreen.main
        let collapsed = Self.collapsedFrame(width: frame.width, screen: screen)
        NSAnimationContext.runAnimationGroup({ context in
            context.duration = 0.30
            context.timingFunction = CAMediaTimingFunction(name: .easeOut)
            self.animator().setFrame(collapsed, display: true)
        }, completionHandler: { [weak self] in
            guard let self, self.generation == myGeneration else { return }
            self.orderOut(nil)
            self.isShown = false
        })
    }

    /// Width of the notch cutout itself, derived from the areas macOS
    /// reserves on either side of it. Screens without a notch (external
    /// displays, older MacBooks) don't vend these areas, so fall back to a
    /// fixed width.
    private static func notchWidth(for screen: NSScreen?) -> CGFloat {
        guard let screen else { return 340 }
        if let left = screen.auxiliaryTopLeftArea, let right = screen.auxiliaryTopRightArea {
            return screen.frame.width - left.width - right.width
        }
        return 340
    }

    private static func panelWidth(for screen: NSScreen?) -> CGFloat {
        max(340, notchWidth(for: screen) + 24)
    }

    private static func collapsedFrame(width: CGFloat, screen: NSScreen?) -> NSRect {
        guard let screen else { return NSRect(x: 0, y: 0, width: width, height: 1) }
        let height = screen.safeAreaInsets.top > 0 ? screen.safeAreaInsets.top : 1
        let x = screen.frame.midX - width / 2
        let y = screen.frame.maxY - height
        return NSRect(x: x, y: y, width: width, height: height)
    }

    private static func targetFrame(width: CGFloat, contentHeight: CGFloat, screen: NSScreen?) -> NSRect {
        guard let screen else { return NSRect(x: 0, y: 0, width: width, height: contentHeight) }
        let height = screen.safeAreaInsets.top + contentHeight
        let x = screen.frame.midX - width / 2
        let y = screen.frame.maxY - height
        return NSRect(x: x, y: y, width: width, height: height)
    }
}
