import Carbon.HIToolbox
import Foundation

/// Global hold-to-talk hotkey. Default ⌥Space; override via UserDefaults
/// pttKeyCode / pttModifiers (Carbon virtual key code + modifier mask).
final class PttHotKey {
    var onDown: (() -> Void)?
    var onUp: (() -> Void)?
    private var hotKeyRef: EventHotKeyRef?
    private var handlerRef: EventHandlerRef?

    func register() {
        let defaults = UserDefaults.standard
        let keyCode = UInt32(defaults.object(forKey: "pttKeyCode") as? Int ?? kVK_Space)
        let modifiers = UInt32(defaults.object(forKey: "pttModifiers") as? Int ?? optionKey)

        var eventTypes = [
            EventTypeSpec(eventClass: OSType(kEventClassKeyboard),
                          eventKind: UInt32(kEventHotKeyPressed)),
            EventTypeSpec(eventClass: OSType(kEventClassKeyboard),
                          eventKind: UInt32(kEventHotKeyReleased)),
        ]
        InstallEventHandler(GetApplicationEventTarget(), { _, event, userData in
            guard let userData, let event else { return noErr }
            let hotKey = Unmanaged<PttHotKey>.fromOpaque(userData).takeUnretainedValue()
            if GetEventKind(event) == UInt32(kEventHotKeyPressed) {
                hotKey.onDown?()
            } else {
                hotKey.onUp?()
            }
            return noErr
        }, 2, &eventTypes, Unmanaged.passUnretained(self).toOpaque(), &handlerRef)

        let hotKeyID = EventHotKeyID(signature: OSType(0x434C_5250) /* "CLRP" */, id: 1)
        RegisterEventHotKey(keyCode, modifiers, hotKeyID,
                            GetApplicationEventTarget(), 0, &hotKeyRef)
    }

    deinit {
        if let hotKeyRef { UnregisterEventHotKey(hotKeyRef) }
        if let handlerRef { RemoveEventHandler(handlerRef) }
    }
}
