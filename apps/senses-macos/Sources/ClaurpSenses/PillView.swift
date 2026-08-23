import SwiftUI
import ClaurpSensesCore

struct PillView: View {
    @ObservedObject var store: HudStore
    let respond: (HudPermission, PermissionDecision) -> Void

    var body: some View {
        content
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .frame(width: 360, alignment: .leading)
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14))
    }

    @ViewBuilder private var content: some View {
        switch store.state.pill {
        case .hidden:
            EmptyView()
        case .listening(let transcript):
            HStack(spacing: 8) {
                Image(systemName: "waveform")
                Text(transcript.isEmpty ? "Listening…" : transcript)
                    .lineLimit(2)
                    .font(.callout)
            }
        case .working(let label, let narration):
            VStack(alignment: .leading, spacing: 2) {
                Text(label).font(.callout.bold())
                if !narration.isEmpty {
                    Text(narration).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                }
            }
        case .permission(let card):
            VStack(alignment: .leading, spacing: 6) {
                Text("\(card.tool) needs permission").font(.callout.bold())
                Text(card.detail).font(.caption).foregroundStyle(.secondary).lineLimit(3)
                HStack {
                    Button("Allow") { respond(card, .allow) }
                        .keyboardShortcut(.defaultAction)
                    Button("Deny") { respond(card, .deny) }
                }
            }
        case .offline:
            HStack(spacing: 8) {
                Image(systemName: "bolt.slash")
                Text("claurp offline").font(.callout)
            }
        }
    }
}
