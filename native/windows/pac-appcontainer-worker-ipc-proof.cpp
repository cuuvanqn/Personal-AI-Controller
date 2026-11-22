// PAC integration experiment: run the actual compiled Bun read-only worker
// as an AppContainer child, with bounded one-shot stdin/stdout JSON IPC.
// It uses disposable AppContainer profile fixtures, never user/POS files.
// CI-only; no GUI/remote integration or production security claim.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <userenv.h>
#include <sddl.h>
#include <string>
#include <vector>
#include <iostream>
#include <algorithm>

#pragma comment(lib, "userenv.lib")
#pragma comment(lib, "advapi32.lib")
#pragma comment(lib, "ole32.lib")

struct H {
    HANDLE h = nullptr;
    H() = default;
    H(const H&) = delete;
    H& operator=(const H&) = delete;
    ~H() { if (h && h != INVALID_HANDLE_VALUE) CloseHandle(h); }
    void close() { if (h && h != INVALID_HANDLE_VALUE) CloseHandle(h); h = nullptr; }
};

static int failure(const char* label) {
    std::cerr << "PAC_BUN_APPCONTAINER_FAILED: " << label
              << " winerr=" << GetLastError() << "\n";
    return 1;
}
static bool acl(const std::wstring& path, const std::wstring& sddl) {
    PSECURITY_DESCRIPTOR desc = nullptr;
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1,
                                                                &desc, nullptr)) return false;
    BOOL ok = SetFileSecurityW(path.c_str(), DACL_SECURITY_INFORMATION, desc);
    LocalFree(desc);
    return !!ok;
}
struct Profile {
    std::wstring name, exe, allowed, denied;
    PSID sid = nullptr;
    PWSTR location = nullptr;
    ~Profile() {
        if (!exe.empty()) DeleteFileW(exe.c_str());
        if (!allowed.empty()) DeleteFileW(allowed.c_str());
        if (!denied.empty()) DeleteFileW(denied.c_str());
        if (location) CoTaskMemFree(location);
        if (sid) FreeSid(sid);
        if (!name.empty()) {
            HRESULT hr = DeleteAppContainerProfile(name.c_str());
            if (FAILED(hr)) std::cerr << "PAC_BUN_PROFILE_CLEANUP_FAILED: hr="
                                      << std::hex << hr << "\n";
        }
    }
};

static std::vector<wchar_t> environment(const std::wstring& profile, bool diagnostics) {
    std::vector<wchar_t> result;
    auto add = [&](const std::wstring& var) {
        result.insert(result.end(), var.begin(), var.end());
        result.push_back(L'\0');
    };
    wchar_t windows[MAX_PATH] = {};
    if (!GetWindowsDirectoryW(windows, MAX_PATH)) return {};
    std::wstring base(windows);
    add(L"SystemRoot=" + base);
    add(L"WINDIR=" + base);
    add(L"PATH=" + base + L"\\System32");
    add(L"TMP=" + profile);
    add(L"TEMP=" + profile);
    add(L"LOCALAPPDATA=" + profile);
    add(L"NODE_ENV=test");
    add(L"PAC_WORKER_LAB_MODE=1");
    add(L"PAC_APP_CONTAINER_FS_LAB=1");
    if (diagnostics) add(L"PAC_WORKER_DIAGNOSTICS=1");
    result.push_back(L'\0');
    return result;
}

static bool workerCall(const Profile& p, const std::string& request, bool expectAllowed,
                       const std::string& expectedMarker = "PAC-AppContainer-Bun-Allowed",
                       std::string* response = nullptr, const std::string& expectedError = "ACCESS_DENIED") {
    H stdinRead, stdinWrite, stdoutRead, stdoutWrite;
    SECURITY_ATTRIBUTES inheritance = {};
    inheritance.nLength = sizeof(inheritance);
    inheritance.bInheritHandle = TRUE;
    if (!CreatePipe(&stdinRead.h, &stdinWrite.h, &inheritance, 0) ||
        !CreatePipe(&stdoutRead.h, &stdoutWrite.h, &inheritance, 0))
        return !failure("CreatePipe");
    if (!SetHandleInformation(stdinWrite.h, HANDLE_FLAG_INHERIT, 0) ||
        !SetHandleInformation(stdoutRead.h, HANDLE_FLAG_INHERIT, 0))
        return !failure("SetHandleInformation");

    SIZE_T size = 0;
    InitializeProcThreadAttributeList(nullptr, 2, 0, &size);
    if (GetLastError() != ERROR_INSUFFICIENT_BUFFER || !size)
        return !failure("Attr size");
    std::vector<BYTE> attributeMemory(size);
    auto attributes = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attributeMemory.data());
    if (!InitializeProcThreadAttributeList(attributes, 2, 0, &size))
        return !failure("Attr init");

    SECURITY_CAPABILITIES caps = {};
    caps.AppContainerSid = p.sid;
    caps.Capabilities = nullptr;
    caps.CapabilityCount = 0;
    HANDLE inheritList[2] = {stdinRead.h, stdoutWrite.h};
    bool attributesReady =
        !!UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
                                    &caps, sizeof(caps), nullptr, nullptr) &&
        !!UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                                    inheritList, sizeof(inheritList), nullptr, nullptr);
    if (!attributesReady) {
        const DWORD saved = GetLastError();
        DeleteProcThreadAttributeList(attributes);
        SetLastError(saved);
        return !failure("AppContainer + handle list");
    }

    STARTUPINFOEXW start = {};
    start.StartupInfo.cb = sizeof(start);
    start.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    start.StartupInfo.hStdInput = stdinRead.h;
    start.StartupInfo.hStdOutput = stdoutWrite.h;
    start.StartupInfo.hStdError = stdoutWrite.h;
    start.lpAttributeList = attributes;

    std::wstring root(p.location);
    std::wstring arguments = L"\"" + p.exe + L"\" \"" + root + L"\"";
    std::vector<wchar_t> command(arguments.begin(), arguments.end());
    command.push_back(L'\0');
    std::vector<wchar_t> env = environment(root, expectAllowed);
    if (env.empty()) {
        DeleteProcThreadAttributeList(attributes);
        return !failure("Worker env");
    }

    H job;
    job.h = CreateJobObjectW(nullptr, nullptr);
    if (!job.h) {
        DeleteProcThreadAttributeList(attributes);
        return !failure("Create Job");
    }
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE |
        JOB_OBJECT_LIMIT_ACTIVE_PROCESS | JOB_OBJECT_LIMIT_PROCESS_MEMORY;
    limits.BasicLimitInformation.ActiveProcessLimit = 1;
    limits.ProcessMemoryLimit = 256ull * 1024ull * 1024ull;
    if (!SetInformationJobObject(job.h, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) {
        DeleteProcThreadAttributeList(attributes);
        return !failure("Job limits");
    }

    PROCESS_INFORMATION info = {};
    BOOL success = CreateProcessW(p.exe.c_str(), command.data(), nullptr, nullptr, TRUE,
                  EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | CREATE_NO_WINDOW |
                  CREATE_UNICODE_ENVIRONMENT, env.data(), root.c_str(),
                  &start.StartupInfo, &info);
    const DWORD creationError = success ? ERROR_SUCCESS : GetLastError();
    DeleteProcThreadAttributeList(attributes);
    if (!success) {
        SetLastError(creationError);
        return !failure("CreateProcessW(AppContainer Bun worker)");
    }
    H child, thread;
    child.h = info.hProcess;
    thread.h = info.hThread;
    // Inheritable ends must be closed in the broker so Bun sees stdin EOF.
    stdinRead.close();
    stdoutWrite.close();

    H childToken;
    DWORD inContainer = 0, returned = 0;
    if (!OpenProcessToken(child.h, TOKEN_QUERY, &childToken.h) ||
        !GetTokenInformation(childToken.h, TokenIsAppContainer,
                             &inContainer, sizeof(inContainer), &returned) ||
        inContainer != 1) {
        TerminateProcess(child.h, 1);
        return !failure("Child identity is not AppContainer");
    }
    if (!AssignProcessToJobObject(job.h, child.h)) {
        TerminateProcess(child.h, 1);
        return !failure("Assign worker to Job");
    }
    if (ResumeThread(thread.h) == DWORD(-1)) {
        TerminateJobObject(job.h, 1);
        return !failure("Resume worker");
    }

    DWORD written = 0;
    if (!WriteFile(stdinWrite.h, request.data(), static_cast<DWORD>(request.size()),
                   &written, nullptr) || written != request.size()) {
        TerminateJobObject(job.h, 1);
        return !failure("Send request");
    }
    stdinWrite.close();

    std::string output;
    const ULONGLONG deadline = GetTickCount64() + 8000;
    for (;;) {
        DWORD available = 0;
        if (PeekNamedPipe(stdoutRead.h, nullptr, 0, nullptr, &available, nullptr) && available) {
            char buffer[4096];
            DWORD read = 0;
            DWORD want = std::min(available, static_cast<DWORD>(sizeof(buffer)));
            if (!ReadFile(stdoutRead.h, buffer, want, &read, nullptr)) {
                TerminateJobObject(job.h, 1);
                return !failure("Read response");
            }
            output.append(buffer, read);
            if (output.size() > 32768) {
                TerminateJobObject(job.h, 1);
                return !failure("Output over 32KiB");
            }
        }
        if (WaitForSingleObject(child.h, 0) == WAIT_OBJECT_0) {
            DWORD trailing = 0;
            if (!PeekNamedPipe(stdoutRead.h, nullptr, 0, nullptr, &trailing, nullptr) || !trailing)
                break;
        }
        if (GetTickCount64() >= deadline) {
            TerminateJobObject(job.h, 1);
            SetLastError(ERROR_TIMEOUT);
            return !failure("Worker timeout");
        }
        Sleep(15);
    }
    DWORD code = 1;
    if (!GetExitCodeProcess(child.h, &code) || code != 0) {
        SetLastError(code);
        return !failure("Worker exit code");
    }
    const bool hasSuccess = output.find("\"ok\":true") != std::string::npos;
    const bool hasDenied = output.find("\"ok\":false") != std::string::npos &&
                           output.find(expectedError) != std::string::npos;
    const bool hasFixture = output.find(expectedMarker) != std::string::npos;
    const bool correct = expectAllowed ? (hasSuccess && hasFixture) : hasDenied;
    if (!correct && expectAllowed) {
        // CI-only, no real files: report only the worker's short sanitized code.
        const size_t pos = output.find("LAB_DIAG_");
        if (pos != std::string::npos)
            std::cerr << "PAC_BUN_ALLOWED_DIAG: " << output.substr(pos, 100) << "\n";
    }
    if (!correct) {
        std::cerr << "PAC_BUN_IPC_DIAGNOSTIC: output_size=" << output.size()
                  << " contains_ok_true=" << hasSuccess
                  << " contains_access_denied=" << hasDenied << "\n";
        return false;
    }
    if (response) *response = output;
    return true;
}

int wmain(int argc, wchar_t** argv) {
    if (argc != 2) return failure("Fixed lab operation required");
    const std::wstring mode(argv[1]);
    const bool ci = mode == L"--ci-lab";
    const bool gui = mode == L"--gui-read" || mode == L"--gui-inspect" ||
                     mode == L"--gui-list" || mode == L"--gui-deny-command" ||
                     mode == L"--gui-deny-path" || mode == L"--gui-verify";
    if (!ci && !gui) return failure("Lab operation denied");
    Profile p;
    p.name = L"PacBunProof_" + std::to_wstring(GetCurrentProcessId()) +
             L"_" + std::to_wstring(GetTickCount64());
    HRESULT hr = CreateAppContainerProfile(p.name.c_str(), L"PAC Bun IPC Lab",
                                          L"Disposable compiled worker IPC test",
                                          nullptr, 0, &p.sid);
    if (FAILED(hr) || !p.sid) {
        std::cerr << "PAC_BUN_APPCONTAINER_FAILED: CreateAppContainerProfile hr="
                  << std::hex << hr << "\n";
        return 1;
    }
    LPWSTR packageRaw = nullptr;
    if (!ConvertSidToStringSidW(p.sid, &packageRaw)) return failure("AppContainer SID");
    std::wstring packageSid(packageRaw);
    LocalFree(packageRaw);
    if (FAILED(GetAppContainerFolderPath(packageSid.c_str(), &p.location)) || !p.location)
        return failure("GetAppContainerFolderPath");
    H owner;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &owner.h))
        return failure("Owner token");
    DWORD size = 0;
    GetTokenInformation(owner.h, TokenUser, nullptr, 0, &size);
    if (GetLastError() != ERROR_INSUFFICIENT_BUFFER || !size)
        return failure("Owner SID size");
    std::vector<BYTE> sidInfo(size);
    if (!GetTokenInformation(owner.h, TokenUser, sidInfo.data(), size, &size))
        return failure("Owner SID");
    LPWSTR ownerRaw = nullptr;
    if (!ConvertSidToStringSidW(reinterpret_cast<TOKEN_USER*>(sidInfo.data())->User.Sid,
                                &ownerRaw))
        return failure("Owner SID text");
    std::wstring ownerSid(ownerRaw);
    LocalFree(ownerRaw);

    const std::wstring root(p.location);
    p.exe = root + L"\\pac-bun-child.exe";
    p.allowed = root + L"\\pac-granted.txt";
    p.denied = root + L"\\pac-owner-only.txt";

    // Fixed sibling executable: the GUI supplies no executable or workspace path.
    // An actual release needs signed, immutable binaries before handling user data.
    wchar_t self[MAX_PATH * 2] = {};
    DWORD n = GetModuleFileNameW(nullptr, self, MAX_PATH * 2);
    if (!n || n >= MAX_PATH * 2) return failure("Find fixed broker");
    std::wstring brokerPath(self);
    const auto split = brokerPath.find_last_of(L"\\/");
    if (split == std::wstring::npos) return failure("Broker directory");
    const std::wstring worker = brokerPath.substr(0, split + 1) + L"pac-worker-lab.exe";
    if (!CopyFileW(worker.c_str(), p.exe.c_str(), TRUE))
        return failure("Stage fixed sibling worker into AppContainer profile");
    if (!acl(p.exe, L"D:P(A;;GA;;;" + ownerSid + L")(A;;GRGX;;;" + packageSid + L")"))
        return failure("Bun executable ACL");

    for (const auto& target : {p.allowed, p.denied}) {
        H h;
        h.h = CreateFileW(target.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr,
                          CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
        if (h.h == INVALID_HANDLE_VALUE) return failure("Create test fixture");
        const char data[] = "PAC-AppContainer-Bun-Allowed";
        DWORD written = 0;
        if (!WriteFile(h.h, data, sizeof(data) - 1, &written, nullptr))
            return failure("Write test fixture");
    }
    if (!acl(p.allowed, L"D:P(A;;GA;;;" + ownerSid + L")(A;;GR;;;" + packageSid + L")") ||
        !acl(p.denied, L"D:P(A;;GA;;;" + ownerSid + L")"))
        return failure("Fixture ACL");

    const std::string allowedRequest =
      "{\"operation\":\"read_text\",\"relativePath\":\"pac-granted.txt\"}";
    const std::string deniedRequest =
      "{\"operation\":\"read_text\",\"relativePath\":\"pac-owner-only.txt\"}";
    const std::string inspectRequest =
      "{\"operation\":\"inspect_file\",\"relativePath\":\"pac-granted.txt\"}";
    const std::string listRequest =
      "{\"operation\":\"list_directory\",\"relativePath\":\".\"}";
    const std::string commandRequest =
      "{\"operation\":\"execute_terminal_command\",\"command\":\"whoami\"}";
    const std::string traversalRequest =
      "{\"operation\":\"read_text\",\"relativePath\":\"../outside.txt\"}";
    if (ci || mode == L"--gui-verify") {
        if (!workerCall(p, allowedRequest, true))
            return failure("AppContainer Bun granted read IPC");
        if (!workerCall(p, deniedRequest, false))
            return failure("AppContainer Bun owner-only denied read IPC");
        if (ci) {
            std::cout << "PAC_BUN_APPCONTAINER_IPC_PASSED: real_bun_worker=true"
                      << " appcontainer_token=true permitted_read=true denied_read=true"
                      << " job_object=true capability_count=0\n";
        } else {
            std::cout << "{\"ok\":true,\"result\":{\"appcontainer\":true,\"allowed\":true,"
                         "\"denied\":true,\"job\":true}}\n";
        }
        return 0;
    }
    std::string request, marker, expectedError, response;
    bool expectAllowed = true;
    if (mode == L"--gui-read") {
        request = allowedRequest;
        marker = "PAC-AppContainer-Bun-Allowed";
    } else if (mode == L"--gui-inspect") {
        request = inspectRequest;
        marker = "\"size\"";
    } else if (mode == L"--gui-list") {
        request = listRequest;
        marker = "pac-granted.txt";
    } else if (mode == L"--gui-deny-command") {
        request = commandRequest; expectAllowed = false; expectedError = "OPERATION_DENIED";
    } else if (mode == L"--gui-deny-path") {
        request = traversalRequest; expectAllowed = false; expectedError = "INVALID_PATH";
    } else return failure("GUI operation unsupported");
    if (!workerCall(p, request, expectAllowed, marker, &response,
                    expectAllowed ? "ACCESS_DENIED" : expectedError))
        return failure("AppContainer GUI operation did not pass expected policy");
    std::cout << response;
    return 0;
}
