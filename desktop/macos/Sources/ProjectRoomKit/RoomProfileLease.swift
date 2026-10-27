import Foundation
import Darwin

public enum ProfileLeaseError: Error { case unavailable, inUse }

/// Hold for the window's entire lifetime, including while hidden. The OS
/// releases this lease on process exit/crash. Never unlink a lock file: doing
/// so would allow two processes to lock different inodes for the same profile.
public final class RoomProfileLease {
    private let descriptor: Int32

    public init(profileID: UUID?, directory: URL = RoomProfileStore().directory) throws {
        let locks = directory.appendingPathComponent("Locks", isDirectory: true)
        try FileManager.default.createDirectory(at: locks, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let path = locks.appendingPathComponent((profileID?.uuidString ?? "default") + ".lock").path
        let fd = Darwin.open(path, O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw ProfileLeaseError.unavailable }
        var info = stat()
        guard fstat(fd, &info) == 0, info.st_uid == geteuid(),
              (info.st_mode & S_IFMT) == S_IFREG, info.st_nlink == 1 else {
            close(fd); throw ProfileLeaseError.unavailable
        }
        guard flock(fd, LOCK_EX | LOCK_NB) == 0 else {
            let busy = errno == EWOULDBLOCK
            close(fd)
            throw busy ? ProfileLeaseError.inUse : ProfileLeaseError.unavailable
        }
        descriptor = fd
    }

    deinit { close(descriptor) }
}
