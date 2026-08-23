import Combine
import ClaurpSensesCore

final class HudStore: ObservableObject {
    @Published var state = HudState()
}
