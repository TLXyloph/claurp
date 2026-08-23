import CoreAudio

/// Locating the built-in microphone for pinning as the capture input device.
///
/// When voice processing (AEC) is enabled on an `AVAudioInputNode`, CoreAudio
/// aggregates *all* input devices (built-in mic, BlackHole, Teams virtual
/// audio, etc.) into a single multi-channel input — on this hardware, a
/// 9-channel aggregate. Which physical device lands on channel 0 is not
/// guaranteed to be the real microphone; it can be a silent virtual device,
/// leaving the daemon fed near-silence. Pinning the input explicitly to the
/// built-in device before enabling voice processing keeps channel 0 on the
/// real mic.
public enum AudioInputDevice {
    /// A CoreAudio input-capable device, as surfaced to the menu-bar
    /// microphone switcher and the mic tester.
    public struct InputDevice: Equatable {
        public let id: AudioDeviceID
        public let uid: String
        public let name: String
    }

    /// Returns the `AudioDeviceID` of the built-in microphone, or `nil` if
    /// none is present (e.g. a headless Mac mini or CI runner) or the
    /// CoreAudio lookup fails. Callers should treat `nil` as "fall back to
    /// the system default input" rather than an error.
    public static func builtInInputID() -> AudioDeviceID? {
        for id in allDeviceIDs() {
            var transport: UInt32 = 0
            var tSize = UInt32(MemoryLayout<UInt32>.size)
            var tAddr = AudioObjectPropertyAddress(
                mSelector: kAudioDevicePropertyTransportType,
                mScope: kAudioObjectPropertyScopeGlobal,
                mElement: kAudioObjectPropertyElementMain)
            guard AudioObjectGetPropertyData(id, &tAddr, 0, nil, &tSize, &transport) == noErr,
                  transport == kAudioDeviceTransportTypeBuiltIn else { continue }
            guard hasInputStreams(id) else { continue }
            return id
        }
        return nil
    }

    /// Enumerates every CoreAudio device that has at least one input
    /// stream — the menu-bar "Microphone" submenu and the mic tester's
    /// device list. Devices missing a readable UID or name are skipped
    /// (both are required to round-trip a user selection via `device
    /// (withUID:)`); returns `[]` rather than throwing if the top-level
    /// device enumeration itself fails.
    public static func allInputDevices() -> [InputDevice] {
        var devices: [InputDevice] = []
        for id in allDeviceIDs() {
            guard hasInputStreams(id) else { continue }
            guard let uid = stringProperty(id, selector: kAudioDevicePropertyDeviceUID) else { continue }
            let name = stringProperty(id, selector: kAudioObjectPropertyName) ?? uid
            devices.append(InputDevice(id: id, uid: uid, name: name))
        }
        return devices
    }

    /// Resolves a persisted device UID (e.g. from `UserDefaults`) back to a
    /// live `AudioDeviceID`, or `nil` if no currently-present input device
    /// has that UID (device unplugged, or UID from a different Mac).
    public static func device(withUID uid: String) -> AudioDeviceID? {
        allInputDevices().first { $0.uid == uid }?.id
    }

    private static func allDeviceIDs() -> [AudioDeviceID] {
        var addr = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDevices,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size) == noErr else {
            return []
        }
        var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &ids) == noErr else {
            return []
        }
        return ids
    }

    private static func hasInputStreams(_ id: AudioDeviceID) -> Bool {
        var sAddr = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyStreams,
            mScope: kAudioDevicePropertyScopeInput,
            mElement: kAudioObjectPropertyElementMain)
        var sSize: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(id, &sAddr, 0, nil, &sSize) == noErr, sSize > 0 else { return false }
        return true
    }

    private static func stringProperty(_ id: AudioDeviceID, selector: AudioObjectPropertySelector) -> String? {
        var addr = AudioObjectPropertyAddress(
            mSelector: selector,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var size = UInt32(MemoryLayout<CFString?>.size)
        var value: CFString?
        let status = withUnsafeMutablePointer(to: &value) { ptr -> OSStatus in
            AudioObjectGetPropertyData(id, &addr, 0, nil, &size, ptr)
        }
        guard status == noErr, let value else { return nil }
        return value as String
    }
}
