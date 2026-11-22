// PAC OS process-confinement experiment. Disposable Windows CI only.
// Claims: CreateProcessAsUserW restricted PRIMARY token, OS-denied access to
// owner-only sentinel, and a Job Object kill-on-close boundary.
// Does NOT demonstrate AppContainer, network confinement, secure IPC, or a
// production-ready worker. Never fall back to CreateProcessW as owner.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <sddl.h>
#include <string>
#include <vector>
#include <iostream>

struct SafeHandle {
  HANDLE h = nullptr;
  ~SafeHandle() { if (h && h != INVALID_HANDLE_VALUE) CloseHandle(h); }
  SafeHandle() = default;
  SafeHandle(const SafeHandle&) = delete;
  SafeHandle& operator=(const SafeHandle&) = delete;
};

static int fail(const char* msg) {
  std::cerr << "PAC_RESTRICTED_PROCESS_FAILED: " << msg
            << " winerr=" << GetLastError() << "\n";
  return 1;
}

static bool readAsCurrent(const wchar_t* file) {
  SafeHandle h;
  h.h = CreateFileW(file, GENERIC_READ, FILE_SHARE_READ, nullptr,
                    OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  return h.h != INVALID_HANDLE_VALUE;
}

int wmain(int argc, wchar_t** argv) {
  if (argc == 3 && wcscmp(argv[1], L"--restricted-child") == 0) {
    SafeHandle currentToken;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &currentToken.h))
      return fail("child token inaccessible");
    if (!IsTokenRestricted(currentToken.h)) return fail("child token not restricted");
    SafeHandle opened;
    opened.h = CreateFileW(argv[2], GENERIC_READ, FILE_SHARE_READ, nullptr,
                           OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    const DWORD error = opened.h == INVALID_HANDLE_VALUE
      ? GetLastError() : ERROR_SUCCESS;
    if (error != ERROR_ACCESS_DENIED) {
      SetLastError(error);
      return fail("restricted process read should have been OS denied");
    }
    std::cout << "PAC_RESTRICTED_CHILD_PASSED: token_restricted=true"
              << " file_read=ERROR_ACCESS_DENIED\n";
    return 0;
  }
  if (argc != 2 || wcscmp(argv[1], L"--ci-lab") != 0) {
    std::cerr << "PAC_RESTRICTED_PROCESS_FAILED: CI-only mode required\n";
    return 1;
  }
  SafeHandle currentToken;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY | TOKEN_DUPLICATE,
                        &currentToken.h)) return fail("OpenProcessToken");
  DWORD len = 0;
  GetTokenInformation(currentToken.h, TokenUser, nullptr, 0, &len);
  if (GetLastError() != ERROR_INSUFFICIENT_BUFFER || !len)
    return fail("TokenUser size");
  std::vector<BYTE> userBuffer(len);
  if (!GetTokenInformation(currentToken.h, TokenUser, userBuffer.data(), len, &len))
    return fail("TokenUser");
  const PSID sid = reinterpret_cast<TOKEN_USER*>(userBuffer.data())->User.Sid;
  LPWSTR userSidRaw = nullptr;
  if (!ConvertSidToStringSidW(sid, &userSidRaw))
    return fail("ConvertSidToStringSid");
  const std::wstring userSid(userSidRaw);
  LocalFree(userSidRaw);

  BYTE worldSidBuffer[SECURITY_MAX_SID_SIZE] = {};
  DWORD worldSize = sizeof(worldSidBuffer);
  if (!CreateWellKnownSid(WinBuiltinUsersSid, nullptr, worldSidBuffer, &worldSize))
    return fail("CreateWellKnownSid");
  SID_AND_ATTRIBUTES world = { worldSidBuffer, 0 };
  SafeHandle restricted;
  if (!CreateRestrictedToken(currentToken.h, DISABLE_MAX_PRIVILEGE,
                             0, nullptr, 0, nullptr, 1, &world, &restricted.h))
    return fail("CreateRestrictedToken primary");
  if (!IsTokenRestricted(restricted.h)) return fail("primary token unrestricted");

  wchar_t tmpDir[MAX_PATH] = {};
  wchar_t tmpName[MAX_PATH] = {};
  if (!GetTempPathW(MAX_PATH, tmpDir) ||
      !GetTempFileNameW(tmpDir, L"pac", 0, tmpName))
    return fail("GetTempFileName");
  std::wstring sentinel(tmpName);
  if (!DeleteFileW(sentinel.c_str())) return fail("Delete temp placeholder");

  // The owner can read; BUILTIN\\Users (the sole restricting SID) is not in DACL.
  const std::wstring sentinelSddl = L"D:P(A;;GA;;;" + userSid + L")";
  PSECURITY_DESCRIPTOR sec = nullptr;
  if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(
         sentinelSddl.c_str(), SDDL_REVISION_1, &sec, nullptr))
    return fail("Sentinel SDDL");
  SECURITY_ATTRIBUTES attrs = {};
  attrs.nLength = sizeof(attrs);
  attrs.lpSecurityDescriptor = sec;
  attrs.bInheritHandle = FALSE;
  SafeHandle created;
  created.h = CreateFileW(sentinel.c_str(), GENERIC_READ | GENERIC_WRITE,
                          0, &attrs, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
  LocalFree(sec);
  if (created.h == INVALID_HANDLE_VALUE) return fail("Create owner-only sentinel");
  const char marker[] = "pac-restricted-process-private";
  DWORD wrote = 0;
  if (!WriteFile(created.h, marker, sizeof(marker), &wrote, nullptr))
    return fail("Write sentinel");
  CloseHandle(created.h); created.h = nullptr;
  if (!readAsCurrent(sentinel.c_str())) return fail("Owner cannot read sentinel");

  wchar_t self[MAX_PATH] = {};
  DWORD selfSize = GetModuleFileNameW(nullptr, self, MAX_PATH);
  if (!selfSize || selfSize >= MAX_PATH) return fail("GetModuleFileName");
  std::wstring staged = std::wstring(tmpName) + L".exe";
  // Stage a test-only copy with read/execute rights for the restricting SID.
  // BUILTIN\\Users also matches standard Windows library and folder ACLs.
  if (!CopyFileW(self, staged.c_str(), TRUE)) return fail("Copy test executable");
  const std::wstring exeSddl = L"D:P(A;;GA;;;" + userSid + L")(A;;GRGX;;;BU)";
  PSECURITY_DESCRIPTOR exeSec = nullptr;
  if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(
         exeSddl.c_str(), SDDL_REVISION_1, &exeSec, nullptr))
    return fail("Executable SDDL");
  const BOOL aclOk = SetFileSecurityW(staged.c_str(), DACL_SECURITY_INFORMATION, exeSec);
  LocalFree(exeSec);
  if (!aclOk) return fail("SetFileSecurity staged exe");

  SafeHandle job;
  job.h = CreateJobObjectW(nullptr, nullptr);
  if (!job.h) return fail("CreateJobObject");
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {};
  limits.BasicLimitInformation.LimitFlags =
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE |
    JOB_OBJECT_LIMIT_ACTIVE_PROCESS |
    JOB_OBJECT_LIMIT_PROCESS_MEMORY;
  limits.BasicLimitInformation.ActiveProcessLimit = 1;
  limits.ProcessMemoryLimit = 256ull * 1024ull * 1024ull;
  if (!SetInformationJobObject(job.h, JobObjectExtendedLimitInformation,
                               &limits, sizeof(limits)))
    return fail("SetInformationJobObject");

  STARTUPINFOW start = {};
  start.cb = sizeof(start);
  PROCESS_INFORMATION proc = {};
  std::wstring args = L"\"" + staged + L"\" --restricted-child \"" + sentinel + L"\"";
  std::vector<wchar_t> commandLine(args.begin(), args.end());
  commandLine.push_back(L'\0');
  // Critical: CreateProcessAsUserW with restricted token only. Never retry
  // with CreateProcessW/current owner token even if Windows reports 1314.
  if (!CreateProcessAsUserW(restricted.h, staged.c_str(), commandLine.data(),
                            nullptr, nullptr, FALSE,
                            CREATE_SUSPENDED | CREATE_NO_WINDOW,
                            nullptr, nullptr, &start, &proc))
    return fail("CreateProcessAsUser restricted token");
  SafeHandle childProcess;
  SafeHandle childThread;
  childProcess.h = proc.hProcess;
  childThread.h = proc.hThread;
  if (!AssignProcessToJobObject(job.h, childProcess.h)) {
    TerminateProcess(childProcess.h, 1);
    return fail("AssignProcessToJobObject");
  }
  if (ResumeThread(childThread.h) == (DWORD)-1) {
    TerminateProcess(childProcess.h, 1);
    return fail("ResumeThread");
  }
  DWORD waited = WaitForSingleObject(childProcess.h, 10000);
  if (waited != WAIT_OBJECT_0) {
    TerminateJobObject(job.h, 1);
    SetLastError(ERROR_TIMEOUT);
    return fail("Restricted child timeout");
  }
  DWORD exitCode = 1;
  if (!GetExitCodeProcess(childProcess.h, &exitCode) || exitCode != 0) {
    SetLastError(exitCode);
    return fail("Restricted child OS-denied proof failed");
  }

  DeleteFileW(staged.c_str());
  DeleteFileW(sentinel.c_str());
  std::cout << "PAC_RESTRICTED_PROCESS_PASSED: restricted_primary=true"
            << " os_denied_file=true job_object_assigned=true\n";
  return 0;
}
