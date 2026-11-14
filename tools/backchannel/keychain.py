# SPDX-License-Identifier: Apache-2.0
"""One dedicated login-Keychain item; credentials never pass through argv."""
import ctypes as C
import secrets
from pathlib import Path

SERVICE = "com.projectroom.backup-mcp.v1"
ACCOUNT = "shared-tailnet-bearer"


def _access(create=False):
    cf = C.CDLL("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")
    sec = C.CDLL("/System/Library/Frameworks/Security.framework/Security")
    ptr = C.c_void_p
    cf.CFStringCreateWithCString.argtypes = [ptr, C.c_char_p, C.c_uint32]
    cf.CFStringCreateWithCString.restype = ptr
    cf.CFDictionaryCreate.argtypes = [ptr, C.POINTER(ptr), C.POINTER(ptr), C.c_long, ptr, ptr]
    cf.CFDictionaryCreate.restype = ptr
    cf.CFArrayCreate.argtypes = [ptr, C.POINTER(ptr), C.c_long, ptr]
    cf.CFArrayCreate.restype = ptr
    cf.CFDataCreate.argtypes = [ptr, ptr, C.c_long]
    cf.CFDataCreate.restype = ptr
    cf.CFDataGetLength.argtypes = [ptr]
    cf.CFDataGetLength.restype = C.c_long
    cf.CFDataGetBytePtr.argtypes = [ptr]
    cf.CFDataGetBytePtr.restype = ptr
    cf.CFRelease.argtypes = [ptr]
    sec.SecItemCopyMatching.argtypes = [ptr, C.POINTER(ptr)]
    sec.SecItemCopyMatching.restype = C.c_int32
    sec.SecItemAdd.argtypes = [ptr, C.POINTER(ptr)]
    sec.SecItemAdd.restype = C.c_int32
    sec.SecKeychainOpen.argtypes = [C.c_char_p, C.POINTER(ptr)]
    sec.SecKeychainOpen.restype = C.c_int32
    held = []

    def symbol(lib, name):
        return ptr.in_dll(lib, name).value

    def string(value):
        result = cf.CFStringCreateWithCString(None, value.encode(), 0x08000100)
        held.append(result)
        return result

    def dictionary(pairs):
        keys = (ptr * len(pairs))(*(symbol(sec, k) for k, _ in pairs))
        values = (ptr * len(pairs))(*(v for _, v in pairs))
        result = cf.CFDictionaryCreate(None, keys, values, len(pairs), None, None)
        held.append(result)
        return result

    try:
        login = ptr()
        login_path = Path.home() / "Library/Keychains/login.keychain-db"
        code = sec.SecKeychainOpen(str(login_path).encode("utf-8"), C.byref(login))
        if code != 0:
            raise RuntimeError("Login Keychain unavailable (OSStatus %d)" % code)
        held.append(login.value)
        search = cf.CFArrayCreate(None, (ptr * 1)(login.value), 1, None)
        held.append(search)
        base = [("kSecClass", symbol(sec, "kSecClassGenericPassword")),
                ("kSecAttrService", string(SERVICE)), ("kSecAttrAccount", string(ACCOUNT))]
        query = dictionary(base + [("kSecMatchSearchList", search), ("kSecReturnData", symbol(cf, "kCFBooleanTrue")),
                                  ("kSecMatchLimit", symbol(sec, "kSecMatchLimitOne")),
                                  ("kSecUseAuthenticationUI", symbol(sec, "kSecUseAuthenticationUIFail"))])
        result = ptr()
        code = sec.SecItemCopyMatching(query, C.byref(result))
        if code == 0:
            try:
                return C.string_at(cf.CFDataGetBytePtr(result), cf.CFDataGetLength(result)).decode("ascii")
            finally:
                cf.CFRelease(result)
        if code != -25300 or not create:
            raise RuntimeError("Dedicated Keychain item unavailable (OSStatus %d)" % code)
        token = secrets.token_urlsafe(32)
        data = token.encode("ascii")
        buffer = C.create_string_buffer(data)
        value = cf.CFDataCreate(None, buffer, len(data))
        held.append(value)
        entry = dictionary(base + [("kSecUseKeychain", login.value), ("kSecValueData", value),
                                   ("kSecAttrLabel", string("Project Room backup MCP shared bearer")),
                                   ("kSecAttrSynchronizable", symbol(cf, "kCFBooleanFalse"))])
        code = sec.SecItemAdd(entry, None)
        if code != 0:
            raise RuntimeError("Dedicated Keychain item creation failed (OSStatus %d)" % code)
        return token
    finally:
        for value in reversed(held):
            cf.CFRelease(value)


def load():
    return _access()


def ensure():
    return _access(create=True)


if __name__ == "__main__":
    ensure()
    print("Dedicated Keychain bearer is available; value not displayed.")
