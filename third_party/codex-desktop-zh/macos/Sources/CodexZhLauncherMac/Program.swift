import AppKit
import Darwin
import Foundation
import SwiftUI

@main
enum Program {
    @MainActor
    static func main() {
        let arguments = Array(CommandLine.arguments.dropFirst())
        if arguments.first == "--apply-update-macos" {
            Darwin.exit(MacUpdateInstaller.apply(arguments: arguments))
        }
        if arguments.first == "--apply-update-macos-test" {
            Darwin.exit(MacUpdateInstaller.apply(arguments: arguments, restart: false))
        }
        if let command = arguments.first {
            Task {
                let exitCode = await runCLI(command: command, options: Array(arguments.dropFirst()))
                fflush(stdout)
                fflush(stderr)
                Darwin.exit(exitCode)
            }
            dispatchMain()
        }

        let application = NSApplication.shared
        let delegate = ApplicationDelegate()
        application.delegate = delegate
        application.setActivationPolicy(.regular)
        application.run()
    }

    private static func runCLI(command: String, options: [String]) async -> Int32 {
        do {
            let resources = try SharedResources()
            if command == "--self-test" {
                print(try resources.selfTest())
                return 0
            }

            let discovery = CodexDiscovery()
            let processService = DarwinProcessService()
            let install = discovery.detect()
            if command == "--diagnostics" {
                print("Codex Localization Enhancer 0.7.7")
                print("os=\(ProcessInfo.processInfo.operatingSystemVersionString)")
                #if arch(arm64)
                print("architecture=arm64")
                #elseif arch(x86_64)
                print("architecture=x64")
                #else
                print("architecture=unknown")
                #endif
                guard let install else {
                    print("codex=not-found")
                    print("log=\(AppLogger.shared.fileURL.path)")
                    return 2
                }
                print("codex=found")
                print("kind=\(install.kind)")
                print("version=\(install.version)")
                print("bundle_id=\(install.bundleIdentifier)")
                print("location=\(install.bundleURL.path)")
                print("running_processes=\(processService.scan(install: install).totalPotentialCount)")
                print("log=\(AppLogger.shared.fileURL.path)")
                return 0
            }

            guard command == "--launch-zh" || command == "--launch-en" else {
                throw CLIError.unknownArgument
            }
            let proxy = try localProxyOption(options)
            guard let install else { throw CLIError.installNotFound }
            let runtime = LocalizationRuntime(
                processService: processService,
                launcher: AppLauncher(processService: processService),
                resources: resources
            )
            let locale = command == "--launch-zh" ? "zh-CN" : "en-US"
            let report = try await runtime.launch(install: install, locale: locale, proxy: proxy)
            print(report.message)
            print("pid=\(report.processID); renderer_port=\(report.rendererPort); inspector_port=\(report.inspectorPort)")
            print("locale=\(report.localeApplied); menu=\(report.menuApplied)")
            return report.complete ? 0 : 2
        } catch {
            fputs("error: \(error.localizedDescription)\n", stderr)
            AppLogger.shared.write("command.failed \(error)")
            return 1
        }
    }

    private static func localProxyOption(_ options: [String]) throws -> String? {
        guard !options.isEmpty else { return nil }
        guard options.count == 1, options[0].hasPrefix("--proxy-server=") else {
            throw CLIError.unknownArgument
        }
        let value = String(options[0].dropFirst("--proxy-server=".count))
        guard let url = URLComponents(string: value), url.scheme == "http",
              ["127.0.0.1", "localhost", "::1"].contains(url.host ?? ""),
              let port = url.port, port > 0, port < 65536,
              url.user == nil, url.password == nil, url.path.isEmpty,
              url.query == nil, url.fragment == nil else {
            throw CLIError.invalidProxy
        }
        return value
    }

    enum CLIError: LocalizedError {
        case unknownArgument
        case installNotFound
        case invalidProxy

        var errorDescription: String? {
            switch self {
            case .unknownArgument: return "未知参数。可用参数：--diagnostics、--self-test、--launch-zh、--launch-en"
            case .installNotFound: return "未检测到 Codex.app 或 ChatGPT.app。"
            case .invalidProxy: return "仅支持 127.0.0.1 的本机 HTTP 代理。"
            }
        }
    }
}

@MainActor
final class ApplicationDelegate: NSObject, NSApplicationDelegate {
    private var window: NSWindow?
    private let model = LauncherModel()

    func applicationDidFinishLaunching(_ notification: Notification) {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 820, height: 620),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Codex 汉化增强工具"
        window.minSize = NSSize(width: 720, height: 560)
        window.center()
        window.appearance = NSAppearance(named: .darkAqua)
        window.contentViewController = NSHostingController(rootView: LauncherView(model: model))
        window.makeKeyAndOrderFront(nil)
        self.window = window
        buildMenus()
        NSApplication.shared.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    private func buildMenus() {
        let main = NSMenu()
        let appItem = NSMenuItem()
        main.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "关于 Codex 汉化增强工具", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "隐藏 Codex 汉化增强工具", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let hideOthers = appMenu.addItem(withTitle: "隐藏其他应用", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(withTitle: "显示全部", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "退出 Codex 汉化增强工具", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu

        let windowItem = NSMenuItem()
        windowItem.title = "窗口"
        main.addItem(windowItem)
        let windowMenu = NSMenu(title: "窗口")
        windowMenu.addItem(withTitle: "最小化", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "缩放", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        windowMenu.addItem(.separator())
        windowMenu.addItem(withTitle: "前置全部窗口", action: #selector(NSApplication.arrangeInFront(_:)), keyEquivalent: "")
        windowItem.submenu = windowMenu
        NSApplication.shared.windowsMenu = windowMenu
        NSApplication.shared.mainMenu = main
    }
}
