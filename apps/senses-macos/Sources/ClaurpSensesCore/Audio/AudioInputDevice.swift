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
    /// Returns the `AudioDeviceID` of the built-in microphone, or `nil` if
    /// none is present (e.g. a headless Mac mini or CI runner) or the
    /// CoreAudio lookup fails. Callers should treat `nil` as "fall back to
    /// the system default input" rather than an error.
    public static func builtInInputID() -> AudioDeviceID? {
        var addr = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDevices,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size) == noErr else {
            return nil
        }
        var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &ids) == noErr else {
            return nil
        }
        for id in ids {
            var transport: UInt32 = 0
            var tSize = UInt32(MemoryLayout<UInt32>.size)
            var tAddr = AudioObjectPropertyAddress(
                mSelector: kAudioDevicePropertyTransportType,
                mScope: kAudioObjectPropertyScopeGlobal,
                mElement: kAudioObjectPropertyElementMain)
            guard AudioObjectGetPropertyData(id, &tAddr, 0, nil, &tSize, &transport) == noErr,
                  transport == kAudioDeviceTransportTypeBuiltIn else { continue }
            var sAddr = AudioObjectPropertyAddress(
                mSelector: kAudioDevicePropertyStreams,
                mScope: kAudioDevicePropertyScopeInput,
                mElement: kAudioObjectPropertyElementMain)
            var sSize: UInt32 = 0
            guard AudioObjectGetPropertyDataSize(id, &sAddr, 0, nil, &sSize) == noErr, sSize > 0 else { continue }
            return id
        }
        return nil
    }
}
