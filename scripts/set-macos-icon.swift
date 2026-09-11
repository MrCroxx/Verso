import AppKit

guard CommandLine.arguments.count == 3 else {
    fatalError("Usage: swift scripts/set-macos-icon.swift icon.icns target")
}
guard let icon = NSImage(contentsOfFile: CommandLine.arguments[1]), icon.isValid else {
    fatalError("Cannot decode the macOS icon")
}
guard NSWorkspace.shared.setIcon(icon, forFile: CommandLine.arguments[2], options: []) else {
    fatalError("Cannot set the macOS file icon")
}
