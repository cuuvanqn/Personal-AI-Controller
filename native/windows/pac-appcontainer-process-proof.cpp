// PAC native AppContainer proof (CI-only): OS permission denial by a
// *separate child process*, with zero requested optional capabilities.
// This is NOT a PAC production broker or a Bun worker launcher.
// Windows AppContainer profile is disposable and cleaned after the test.
#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <userenv.h>
#include <sddl.h>
#include <string>
#include <vector>
#include <iostream>

#pragma comment(lib, "userenv.lib")
#pragma comment(lib, "advapi32.lib")

struct H {
    HANDLE h = nullptr;
    H() = default;
    H(const H&) = delete;
    H& operator=(const H&) = delete;
    ~H() { if (h && h != INVALID_HANDLE_VALUE) CloseHandle(h); }
};

struct Cleanup {
    std::wstring name, executable, granted, blocked;
    PSID sid = nullptr;
    PWSTR folder = nullptr;
    ~Cleanup() {
        if (!executable.empty()) DeleteFileW(executable.c_str());
        if (!granted.empty()) DeleteFileW(granted.c_str());
        if (!blocked.empty()) DeleteFileW(blocked.c_str());
        if (sid) FreeSid(sid);
        if (folder) CoTaskMemFree(folder);
        if (!name.empty()) {
            HRESULT hr = DeleteAppContainerProfile(name.c_str());
            if (FAILED(hr)) std::cerr << "PAC_APP_PROFILE_CLEANUP_HRESULT=" << std::hex << hr << "\n";
        }
    }
};

static int fail(const char* label) {
    std::cerr << "PAC_APP_CONTAINER_FAILED: " << label
              << " error=" << GetLastError() << "\n";
    return 1;
}

static bool readFile(const std::wstring& p, DWORD* error = nullptr) {
    H h;
    h.h = CreateFileW(p.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr,
                      OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    DWORD code = h.h == INVALID_HANDLE_VALUE ? GetLastError() : ERROR_SUCCESS;
    if (error) *error = code;
    return code == ERROR_SUCCESS;
}

static bool applyAcl(const std::wstring& p, const std::wstring& sddl) {
    PSECURITY_DESCRIPTOR descriptor = nullptr;
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(
          sddl.c_str(), SDDL_REVISION_1, &descriptor, nullptr)) return false;
    const BOOL ok = SetFileSecurityW(p.c_str(), DACL_SECURITY_INFORMATION, descriptor);
    LocalFree(descriptor);
    return !!ok;
}

static int child(int argc, wchar_t** argv) {
    if (argc != 4) return fail("child args");
    H token;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token.h))
        return fail("child token");
    DWORD isAppContainer = 0, bytes = 0;
    if (!GetTokenInformation(token.h, TokenIsAppContainer, &isAppContainer,
                             sizeof(isAppContainer), &bytes) || isAppContainer != 1)
        return fail("child is not an AppContainer");

    DWORD grantedError = 0, blockedError = 0;
    const bool allowedRead = readFile(argv[2], &grantedError);
    const bool forbiddenRead = readFile(argv[3], &blockedError);
    if (!allowedRead || forbiddenRead || blockedError != ERROR_ACCESS_DENIED) {
        SetLastError(!allowedRead ? grantedError : blockedError);
        return fail("child OS ACL access-test mismatch");
    }
    std::cout << "PAC_APPCONTAINER_CHILD_PASSED: appcontainer=true"
              << " granted_read=true"
              << " owner_only_read=ERROR_ACCESS_DENIED\n";
    return 0;
}

int wmain(int argc, wchar_t** argv) {
    if (argc > 1 && wcscmp(argv[1], L"--child") == 0) return child(argc, argv);
    if (argc != 2 || wcscmp(argv[1], L"--ci-lab") != 0) {
        std::cerr << "PAC_APP_CONTAINER_FAILED: only CI lab mode is supported\n";
        return 1;
    }
    Cleanup cleanup;
    // Disposable profile name, no collision across hosted job attempts.
    cleanup.name = L"PacLabProof_" + std::to_wstring(GetCurrentProcessId()) +
                   L"_" + std::to_wstring(GetTickCount64());
    HRESULT hr = CreateAppContainerProfile(cleanup.name.c_str(),
                 L"PAC CI AppContainer Proof",
                 L"Disposable Windows sandbox experiment",
                 nullptr, 0, &cleanup.sid);
    if (FAILED(hr) || !cleanup.sid) {
        std::cerr << "PAC_APP_CONTAINER_FAILED: CreateAppContainerProfile hr="
                  << std::hex << hr << "\n";
        return 1;
    }
    LPWSTR sidStringRaw = nullptr;
    if (!ConvertSidToStringSidW(cleanup.sid, &sidStringRaw)) return fail("SID string");
    const std::wstring containerSidString(sidStringRaw);
    LocalFree(sidStringRaw);

    if (FAILED(GetAppContainerFolderPath(containerSidString.c_str(), &cleanup.folder))
        || !cleanup.folder) return fail("GetAppContainerFolderPath");
    const std::wstring folder(cleanup.folder);
    if (GetFileAttributesW(folder.c_str()) == INVALID_FILE_ATTRIBUTES)
        return fail("AppContainer local data folder missing");

    H owner;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &owner.h))
        return fail("owner token");
    DWORD len = 0;
    GetTokenInformation(owner.h, TokenUser, nullptr, 0, &len);
    if (GetLastError() != ERROR_INSUFFICIENT_BUFFER || !len)
        return fail("owner SID len");
    std::vector<BYTE> ownerData(len);
    if (!GetTokenInformation(owner.h, TokenUser, ownerData.data(), len, &len))
        return fail("owner SID");
    const PSID ownerSid = reinterpret_cast<TOKEN_USER*>(ownerData.data())->User.Sid;
    LPWSTR ownerRaw = nullptr;
    if (!ConvertSidToStringSidW(ownerSid, &ownerRaw)) return fail("owner SID str");
    const std::wstring ownerSidText(ownerRaw);
    LocalFree(ownerRaw);

    cleanup.executable = folder + L"\\pac-app-container-child.exe";
    cleanup.granted = folder + L"\\pac-granted.txt";
    cleanup.blocked = folder + L"\\pac-owner-only.txt";

    wchar_t self[MAX_PATH] = {};
    const DWORD selfLen = GetModuleFileNameW(nullptr, self, MAX_PATH);
    if (!selfLen || selfLen >= MAX_PATH) return fail("GetModuleFileName");
    if (!CopyFileW(self, cleanup.executable.c_str(), TRUE))
        return fail("Copy fixed CI child into AppContainer data folder");

    const std::wstring exeAcl = L"D:P(A;;GA;;;" + ownerSidText +
                L")(A;;GRGX;;;" + containerSidString + L")(A;;GRGX;;;SY)";
    if (!applyAcl(cleanup.executable, exeAcl))
        return fail("Executable ACL");

    for (const auto& p : {cleanup.granted, cleanup.blocked}) {
        H handle;
        handle.h = CreateFileW(p.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr,
                              CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
        if (handle.h == INVALID_HANDLE_VALUE) return fail("Create fixture");
        const char fixture[] = "PAC-AppContainer-CI-only";
        DWORD written = 0;
        if (!WriteFile(handle.h, fixture, sizeof(fixture), &written, nullptr))
            return fail("Write fixture");
    }
    const std::wstring allowAcl = L"D:P(A;;GA;;;" + ownerSidText +
                                      L")(A;;GR;;;" + containerSidString + L")";
    const std::wstring denyAcl = L"D:P(A;;GA;;;" + ownerSidText + L")";
    if (!applyAcl(cleanup.granted, allowAcl) || !applyAcl(cleanup.blocked, denyAcl))
        return fail("Fixture ACL");

    if (!readFile(cleanup.granted) || !readFile(cleanup.blocked))
        return fail("Parent cannot read fixtures");

    SIZE_T attrSize = 0;
    InitializeProcThreadAttributeList(nullptr, 1, 0, &attrSize);
    if (GetLastError() != ERROR_INSUFFICIENT_BUFFER || !attrSize)
        return fail("Attribute size");
    std::vector<BYTE> attrs(attrSize);
    auto list = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attrs.data());
    if (!InitializeProcThreadAttributeList(list, 1, 0, &attrSize))
        return fail("Initialize attributes");

    SECURITY_CAPABILITIES caps = {};
    caps.AppContainerSid = cleanup.sid;
    caps.Capabilities = nullptr;
    caps.CapabilityCount = 0;  // No requested network or other capabilities.
    if (!UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
                                    &caps, sizeof(caps), nullptr, nullptr)) {
        DeleteProcThreadAttributeList(list);
        return fail("Update AppContainer security capabilities");
    }

    STARTUPINFOEXW si = {};
    si.StartupInfo.cb = sizeof(si);
    si.lpAttributeList = list;
    PROCESS_INFORMATION pi = {};
    std::wstring cmd = L"\"" + cleanup.executable + L"\" --child \"" +
                       cleanup.granted + L"\" \"" + cleanup.blocked + L"\"";
    std::vector<wchar_t> mutableCommand(cmd.begin(), cmd.end());
    mutableCommand.push_back(L'\0');

    H job;
    job.h = CreateJobObjectW(nullptr, nullptr);
    if (!job.h) {
        DeleteProcThreadAttributeList(list);
        return fail("Job Object create");
    }
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {};
    limits.BasicLimitInformation.LimitFlags =
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS |
        JOB_OBJECT_LIMIT_PROCESS_MEMORY;
    limits.BasicLimitInformation.ActiveProcessLimit = 1;
    limits.ProcessMemoryLimit = 256ull * 1024ull * 1024ull;
    if (!SetInformationJobObject(job.h, JobObjectExtendedLimitInformation,
                                 &limits, sizeof(limits))) {
        DeleteProcThreadAttributeList(list);
        return fail("Job Object limits");
    }

    // No unrestricted fallback. Security is supplied by the AppContainer
    // attribute, not a post-launch impersonation or TypeScript path check.
    const BOOL spawned = CreateProcessW(cleanup.executable.c_str(),
                       mutableCommand.data(), nullptr, nullptr, FALSE,
                       EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | CREATE_NO_WINDOW,
                       nullptr, folder.c_str(), &si.StartupInfo, &pi);
    const DWORD spawnError = spawned ? ERROR_SUCCESS : GetLastError();
    DeleteProcThreadAttributeList(list);
    if (!spawned) {
        SetLastError(spawnError);
        return fail("AppContainer CreateProcessW (no fallback)");
    }
    H process, thread;
    process.h = pi.hProcess;
    thread.h = pi.hThread;

    if (!AssignProcessToJobObject(job.h, process.h)) {
        TerminateProcess(process.h, 1);
        return fail("Assign AppContainer child to Job Object");
    }
    if (ResumeThread(thread.h) == DWORD(-1)) {
        TerminateJobObject(job.h, 1);
        return fail("Resume AppContainer child");
    }
    const DWORD waited = WaitForSingleObject(process.h, 10000);
    if (waited != WAIT_OBJECT_0) {
        TerminateJobObject(job.h, 1);
        SetLastError(ERROR_TIMEOUT);
        return fail("AppContainer child timeout");
    }
    DWORD exitCode = 1;
    if (!GetExitCodeProcess(process.h, &exitCode) || exitCode != 0) {
        SetLastError(exitCode);
        return fail("AppContainer child denied-access test failed");
    }
    std::cout << "PAC_APPCONTAINER_PROOF_PASSED: restricted_process=true"
              << " allowed_fixture=true owner_only_denied=true"
              << " capabilities=0 job_object=true\n";
    return 0;
}
