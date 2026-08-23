import Foundation

public enum BinaryFrameType: UInt8 {
    case micPcm16k = 0x01
    case ttsPcm24k = 0x02
}

public enum FrameCodecError: Error, Equatable {
    case malformed
}

/// Mirrors packages/protocol messages.ts: [1 byte type][little-endian PCM16 payload].
public enum FrameCodec {
    public static func encode(_ type: BinaryFrameType, pcm: [Int16]) -> Data {
        var data = Data(capacity: 1 + pcm.count * 2)
        data.append(type.rawValue)
        for sample in pcm {
            let le = UInt16(bitPattern: sample)
            data.append(UInt8(le & 0xFF))
            data.append(UInt8(le >> 8))
        }
        return data
    }

    public static func decode(_ data: Data) throws -> (type: UInt8, pcm: [Int16]) {
        guard data.count >= 1, (data.count - 1) % 2 == 0 else {
            throw FrameCodecError.malformed
        }
        let bytes = [UInt8](data) // normalizes slice indices
        let type = bytes[0]
        var pcm = [Int16]()
        pcm.reserveCapacity((bytes.count - 1) / 2)
        var i = 1
        while i < bytes.count {
            pcm.append(Int16(bitPattern: UInt16(bytes[i]) | (UInt16(bytes[i + 1]) << 8)))
            i += 2
        }
        return (type, pcm)
    }
}
