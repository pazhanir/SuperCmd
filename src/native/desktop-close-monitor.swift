import AppKit
import Foundation
import Darwin

private typealias CGSMainConnectionIDFunction = @convention(c) () -> UInt32
private typealias CGSCopyManagedDisplaySpacesFunction = @convention(c) (UInt32) -> Unmanaged<CFArray>?

private struct SpaceSnapshot {
  let ids: [Int64]
  var count: Int { ids.count }
}

private func emit(_ payload: [String: Any]) {
  guard
    let data = try? JSONSerialization.data(withJSONObject: payload, options: []),
    let bytes = (String(data: data, encoding: .utf8) ?? "").appending("\n").data(using: .utf8)
  else { return }
  FileHandle.standardOutput.write(bytes)
}

private func extractInt64(_ value: Any?) -> Int64? {
  if let number = value as? NSNumber { return number.int64Value }
  if let intValue = value as? Int { return Int64(intValue) }
  if let int64Value = value as? Int64 { return int64Value }
  if let stringValue = value as? String { return Int64(stringValue) }
  return nil
}

private func loadSkyLightHandle() -> UnsafeMutableRawPointer? {
  let candidates = [
    "/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight",
    "/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics",
  ]
  for candidate in candidates {
    if let handle = dlopen(candidate, RTLD_NOW) {
      return handle
    }
  }
  return nil
}

private let skyLightHandle = loadSkyLightHandle()

private func captureSpaceSnapshot() -> SpaceSnapshot? {
  guard let skyLightHandle else { return nil }
  guard
    let mainConnectionSymbol = dlsym(skyLightHandle, "CGSMainConnectionID"),
    let copyManagedSpacesSymbol = dlsym(skyLightHandle, "CGSCopyManagedDisplaySpaces")
  else {
    return nil
  }

  let mainConnection = unsafeBitCast(mainConnectionSymbol, to: CGSMainConnectionIDFunction.self)
  let copyManagedSpaces = unsafeBitCast(copyManagedSpacesSymbol, to: CGSCopyManagedDisplaySpacesFunction.self)
  guard let managedSpaces = copyManagedSpaces(mainConnection())?.takeRetainedValue() as? [[String: Any]] else {
    return nil
  }

  var ids: [Int64] = []
  for displayInfo in managedSpaces {
    guard let spaces = displayInfo["Spaces"] as? [[String: Any]] else { continue }
    for space in spaces {
      if let id = extractInt64(space["ManagedSpaceID"]) {
        ids.append(id)
      }
    }
  }

  return SpaceSnapshot(ids: ids)
}

final class DesktopCloseMonitor {
  private let queue = DispatchQueue(label: "com.supercmd.desktop-close-monitor")
  private let timer: DispatchSourceTimer
  private var lastSnapshot: SpaceSnapshot?
  private var debounceWorkItem: DispatchWorkItem?
  private var observers: [NSObjectProtocol] = []

  init() {
    self.timer = DispatchSource.makeTimerSource(queue: queue)
    self.lastSnapshot = captureSpaceSnapshot()
  }

  func start() {
    let workspaceCenter = NSWorkspace.shared.notificationCenter
    let activeSpaceObserver = workspaceCenter.addObserver(
      forName: NSWorkspace.activeSpaceDidChangeNotification,
      object: nil,
      queue: nil
    ) { [weak self] _ in
      self?.scheduleCheck(reason: "active-space")
    }
    observers.append(activeSpaceObserver)

    timer.schedule(deadline: .now() + .milliseconds(180), repeating: .milliseconds(180), leeway: .milliseconds(60))
    timer.setEventHandler { [weak self] in
      self?.check(reason: "poll")
    }
    timer.resume()

    emit([
      "ready": true,
      "spaces": lastSnapshot?.count ?? 0,
    ])
  }

  private func scheduleCheck(reason: String) {
    queue.async {
      self.debounceWorkItem?.cancel()
      let workItem = DispatchWorkItem { [weak self] in
        self?.check(reason: reason)
      }
      self.debounceWorkItem = workItem
      self.queue.asyncAfter(deadline: .now() + .milliseconds(40), execute: workItem)
    }
  }

  private func check(reason: String) {
    guard let currentSnapshot = captureSpaceSnapshot() else { return }
    let previousSnapshot = lastSnapshot
    lastSnapshot = currentSnapshot
    guard let previousSnapshot else { return }
    guard currentSnapshot.count < previousSnapshot.count else { return }

    let removedIds = Set(previousSnapshot.ids).subtracting(Set(currentSnapshot.ids))
    emit([
      "event": "desktop-removed",
      "reason": reason,
      "previousCount": previousSnapshot.count,
      "currentCount": currentSnapshot.count,
      "removedCount": removedIds.count,
    ])
  }
}

guard skyLightHandle != nil else {
  fputs("[Spaces][native] Failed to load SkyLight/CoreGraphics for managed Spaces access.\n", stderr)
  exit(1)
}

let monitor = DesktopCloseMonitor()
monitor.start()
RunLoop.main.run()
