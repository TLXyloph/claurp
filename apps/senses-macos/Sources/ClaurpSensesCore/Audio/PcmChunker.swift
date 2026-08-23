/// Accumulates arbitrary-size sample batches into fixed 20 ms wire chunks.
public struct PcmChunker {
    public let chunkSize: Int
    private var pending: [Int16] = []

    public init(chunkSize: Int = 320) {
        self.chunkSize = chunkSize
    }

    public mutating func push(_ samples: [Int16]) -> [[Int16]] {
        pending.append(contentsOf: samples)
        var chunks: [[Int16]] = []
        while pending.count >= chunkSize {
            chunks.append(Array(pending.prefix(chunkSize)))
            pending.removeFirst(chunkSize)
        }
        return chunks
    }

    public mutating func reset() {
        pending.removeAll()
    }
}
