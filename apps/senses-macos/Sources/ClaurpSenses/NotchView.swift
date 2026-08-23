import SwiftUI
import ClaurpSensesCore

/// Content of the notch drop-down: a black panel with square top corners
/// (flush with the screen's top edge) and rounded bottom corners, so it
/// reads as an extension of the physical MacBook notch.
struct NotchView: View {
    @ObservedObject var store: HudStore
    @ObservedObject var levelStore: MicLevelStore
    let width: CGFloat
    let topInset: CGFloat
    let respond: (HudPermission, PermissionDecision) -> Void

    var body: some View {
        VStack(spacing: 0) {
            // Reserves the notch/safe-area height so controls never render
            // under the physical camera housing.
            Color.clear.frame(height: topInset)
            content
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
        }
        .frame(width: width, alignment: .top)
        .background(Color.black,
                    in: UnevenRoundedRectangle(bottomLeadingRadius: 18, bottomTrailingRadius: 18))
        .animation(.spring(response: 0.3, dampingFraction: 0.8), value: store.state.pill)
    }

    @ViewBuilder private var content: some View {
        switch store.state.pill {
        case .hidden:
            EmptyView()
        case .listening(let transcript):
            HStack(spacing: 8) {
                WaveformView(levelStore: levelStore)
                Text(transcript.isEmpty ? "Listening…" : transcript)
                    .lineLimit(2)
                    .font(.callout)
                    .foregroundStyle(.white)
            }
        case .working(let label, let narration):
            VStack(alignment: .leading, spacing: 2) {
                Text(label).font(.callout.bold()).foregroundStyle(.white)
                if !narration.isEmpty {
                    Text(narration)
                        .font(.caption)
                        .foregroundStyle(.white.opacity(0.7))
                        .lineLimit(2)
                }
            }
        case .permission(let card):
            VStack(alignment: .leading, spacing: 6) {
                Text("\(card.tool) needs permission").font(.callout.bold()).foregroundStyle(.white)
                Text(card.detail)
                    .font(.caption)
                    .foregroundStyle(.white.opacity(0.7))
                    .lineLimit(3)
                HStack {
                    Button("Allow") { respond(card, .allow) }
                        .keyboardShortcut(.defaultAction)
                    Button("Deny") { respond(card, .deny) }
                }
            }
        case .offline:
            HStack(spacing: 8) {
                Image(systemName: "bolt.slash").foregroundStyle(.white)
                Text("claurp offline").font(.callout).foregroundStyle(.white)
            }
        }
    }
}
