import Foundation

/// Append-only file logger for stage-by-stage audio pipeline diagnostics.
///
/// The unified log (os_log/NSLog) is unreadable for this unsigned dev build,
/// so this writes plain timestamped lines to /tmp/claurp-senses.log instead.
/// Enabled unless UserDefaults "claurpDebugAudio" is explicitly set to false.
enum DebugAudioLog {
    private static let path = "/tmp/claurp-senses.log"
    private static let queue = DispatchQueue(label: "dev.claurp.senses.debugaudiolog")
    private static let dateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd HH:mm:ss.SSS"
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone.current
        return formatter
    }()

    static var isEnabled: Bool {
        // "explicitly set false" — UserDefaults.bool defaults to false when
        // the key is absent, so distinguish absence from an explicit false.
        if UserDefaults.standard.object(forKey: "claurpDebugAudio") == nil {
            return true
        }
        return UserDefaults.standard.bool(forKey: "claurpDebugAudio")
    }

    static func log(_ message: @autoclosure @escaping () -> String) {
        guard isEnabled else { return }
        queue.async {
            let line = "[\(dateFormatter.string(from: Date()))] \(message())\n"
            guard let data = line.data(using: .utf8) else { return }
            if let handle = FileHandle(forWritingAtPath: path) {
                defer { handle.closeFile() }
                handle.seekToEndOfFile()
                handle.write(data)
            } else {
                FileManager.default.createFile(atPath: path, contents: data)
            }
        }
    }
}
