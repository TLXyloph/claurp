import Foundation

/// 0.5 s doubling to a 10 s cap, ±20% jitter (spec §5).
public struct Backoff {
    private let initial: TimeInterval
    private let cap: TimeInterval
    private let jitterRange: ClosedRange<Double>
    private let random: (ClosedRange<Double>) -> Double
    private var current: TimeInterval?

    public init(initial: TimeInterval = 0.5,
                cap: TimeInterval = 10,
                jitterRange: ClosedRange<Double> = 0.8...1.2,
                random: @escaping (ClosedRange<Double>) -> Double = { .random(in: $0) }) {
        self.initial = initial
        self.cap = cap
        self.jitterRange = jitterRange
        self.random = random
    }

    public mutating func next() -> TimeInterval {
        let base = current.map { min($0 * 2, cap) } ?? initial
        current = base
        return base * random(jitterRange)
    }

    public mutating func reset() {
        current = nil
    }
}
