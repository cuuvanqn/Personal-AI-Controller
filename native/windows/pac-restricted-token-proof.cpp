// PAC native restricted-token access-check experiment.
// Windows CI disposable test only. This DOES NOT launch a worker, isolate
// a process, configure a network policy, or establish an AppContainer.
// Its one claim: OS access control denies a user-only file when the thread
// impersonates a token with a restricting SID not present in the DACL.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <sddl.h>
#include <securitybaseapi.h>
#include <string>
#include <vector>
#include <iostream>

struct Handle {
  HANDLE value = nullptr;
  ~Handle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); }
  Handle() = default;
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
};

static int fail(const char* message) {
  std::cerr << "PAC_NATIVE_PROOF_FAILED: " << message
            << " (Win32 " << GetLastError() << ")\n";
  return 1;
}

int wmain() {
  Handle original;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY | TOKEN_DUPLICATE,
                        &original.value)) return fail("OpenProcessToken");

  DWORD size = 0;
  GetTokenInformation(original.value, TokenUser, nullptr, 0, &size);
  if (GetLastError() != ERROR_INSUFFICIENT_BUFFER || size == 0)
    return fail("TokenUser size");
  std::vector<BYTE> tokenUser(size);
  if (!GetTokenInformation(original.value, TokenUser, tokenUser.data(),
                           size, &size)) return fail("TokenUser");
  PSID userSid = reinterpret_cast<TOKEN_USER*>(tokenUser.data())->User.Sid;
  LPWSTR sidRaw = nullptr;
  if (!ConvertSidToStringSidW(userSid, &sidRaw)) return fail("SID string");
  std::wstring userSidText(sidRaw);
  LocalFree(sidRaw);

  Handle impersonation;
  if (!DuplicateTokenEx(original.value, TOKEN_ALL_ACCESS, nullptr,
                        SecurityImpersonation, TokenImpersonation,
                        &impersonation.value))
    return fail("DuplicateTokenEx");

  // The object's DACL grants the owner only, not Everyone.
  // Add Everyone as a restricting SID: both access checks must pass,
  // so a user-only DACL fails the *second* OS access check.
  BYTE everyoneBuffer[SECURITY_MAX_SID_SIZE] = {};
  DWORD everyoneSize = sizeof(everyoneBuffer);
  if (!CreateWellKnownSid(WinWorldSid, nullptr, everyoneBuffer, &everyoneSize))
    return fail("CreateWellKnownSid");
  SID_AND_ATTRIBUTES restrictSid = { everyoneBuffer, 0 };
  Handle restricted;
  if (!CreateRestrictedToken(impersonation.value, DISABLE_MAX_PRIVILEGE,
                             0, nullptr, 0, nullptr, 1, &restrictSid,
                             &restricted.value)) return fail("CreateRestrictedToken");
  if (!IsTokenRestricted(restricted.value)) return fail("Token not restricted");

  std::wstring sddl = L"D:P(A;;GA;;;" + userSidText + L")";
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(
         sddl.c_str(), SDDL_REVISION_1, &descriptor, nullptr))
    return fail("SDDL parse");

  wchar_t tempPath[MAX_PATH] = {};
  wchar_t tempFile[MAX_PATH] = {};
  if (!GetTempPathW(MAX_PATH, tempPath) ||
      !GetTempFileNameW(tempPath, L"pac", 0, tempFile)) {
    LocalFree(descriptor);
    return fail("Temporary file creation");
  }
  // The temp name is unique on the disposable CI runner.
  if (!DeleteFileW(tempFile)) {
    LocalFree(descriptor);
    return fail("Remove initial temp file");
  }
  SECURITY_ATTRIBUTES attrs = {};
  attrs.nLength = sizeof(attrs);
  attrs.lpSecurityDescriptor = descriptor;
  attrs.bInheritHandle = FALSE;

  Handle sentinel;
  sentinel.value = CreateFileW(tempFile, GENERIC_READ | GENERIC_WRITE,
                               0, &attrs, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
  LocalFree(descriptor);
  if (sentinel.value == INVALID_HANDLE_VALUE) return fail("Private file creation");
  const char proof[] = "pac-user-only-file";
  DWORD written = 0;
  if (!WriteFile(sentinel.value, proof, sizeof(proof), &written, nullptr))
    return fail("Write sentinel");
  CloseHandle(sentinel.value);
  sentinel.value = nullptr;

  Handle ownerRead;
  ownerRead.value = CreateFileW(tempFile, GENERIC_READ, FILE_SHARE_READ, nullptr,
                               OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (ownerRead.value == INVALID_HANDLE_VALUE) {
    DeleteFileW(tempFile);
    return fail("Unrestricted owner must read private file");
  }
  CloseHandle(ownerRead.value);
  ownerRead.value = nullptr;

  if (!ImpersonateLoggedOnUser(restricted.value)) {
    DeleteFileW(tempFile);
    return fail("Impersonate restricted token");
  }
  HANDLE denied = CreateFileW(tempFile, GENERIC_READ, FILE_SHARE_READ, nullptr,
                              OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  DWORD restrictedError = (denied == INVALID_HANDLE_VALUE) ? GetLastError() : ERROR_SUCCESS;
  if (denied != INVALID_HANDLE_VALUE) CloseHandle(denied);
  if (!RevertToSelf()) return fail("RevertToSelf");
  DeleteFileW(tempFile);
  if (restrictedError != ERROR_ACCESS_DENIED) {
    SetLastError(restrictedError);
    return fail("OS did not deny restricted token read");
  }
  std::cout << "PAC_NATIVE_PROOF_PASSED:"
            << " token_restricted=true"
            << " owner_read=allowed"
            << " restricted_read=ERROR_ACCESS_DENIED"
            << "\n";
  return 0;
}
