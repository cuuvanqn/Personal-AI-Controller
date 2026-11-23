// PAC Alpha Lab v0.2 — WinForms UI for disposable fixture data ONLY.
// GUI is an ordinary process; the fixed native broker launches the read-only
// Bun worker as a distinct AppContainer process. Lab fixtures only.
// There are intentionally no user-supplied paths, command inputs, networking,
// remote APIs, browser integration, or elevation requests.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal static class LabWorker
{
    internal static string WorkerPath
    {
        get { return Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "PAC-AppContainer-Broker.exe"); }
    }

    internal static string NewFixture()
    {
        string dir = Path.Combine(Path.GetTempPath(), "pac-alpha-sample-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        Directory.CreateDirectory(Path.Combine(dir, "du-lieu"));
        File.WriteAllText(Path.Combine(dir, "chao-mung.txt"),
            "PAC Alpha Lab v0.2\r\nDay la du lieu MAU de thu nghiem worker.\r\nKhong su dung tep ca nhan.",
            new UTF8Encoding(false));
        File.WriteAllText(Path.Combine(dir, "du-lieu", "vi-du.txt"),
            "Worker chi duoc giao ba tac vu doc: read_text, inspect_file, list_directory.",
            new UTF8Encoding(false));
        return dir;
    }

    internal static Dictionary<string, object> Parse(string json)
    {
        var parsed = new JavaScriptSerializer().DeserializeObject(json.Trim()) as Dictionary<string, object>;
        if (parsed == null || !parsed.ContainsKey("ok") || !(parsed["ok"] is bool))
            throw new InvalidOperationException("Phan hoi worker khong hop le.");
        return parsed;
    }

    // The native broker is a separate process. A corrupted broker could flood
    // stdout; never allocate an unbounded string before checking its size.
    private static string ReadBrokerOutputBounded(Process process)
    {
        var buffer = new char[2048];
        var result = new StringBuilder();
        while (true)
        {
            int read = process.StandardOutput.Read(buffer, 0, buffer.Length);
            if (read == 0) return result.ToString();
            if (result.Length + read > 32768)
            {
                try { if (!process.HasExited) process.Kill(); } catch (InvalidOperationException) {}
                throw new InvalidOperationException("Phan hoi vuot gioi han 32 KiB.");
            }
            result.Append(buffer, 0, read);
        }
    }

    internal static string Call(string workspace, string json, Action<Process> started)
    {
        if (!File.Exists(WorkerPath))
            throw new FileNotFoundException("Khong tim thay PAC-AppContainer-Broker.exe.", WorkerPath);
        if (!Directory.Exists(workspace) || !Path.GetFileName(workspace).StartsWith("pac-alpha-sample-", StringComparison.Ordinal))
            throw new InvalidOperationException("Chi cho phep bo du lieu mau do PAC tao.");
        // GUI never supplies an executable, root path or shell command.
        // The native broker only accepts six internally fixed lab operations.
        var payload = new JavaScriptSerializer().DeserializeObject(json) as Dictionary<string, object>;
        if (payload == null || !payload.ContainsKey("operation"))
            throw new InvalidOperationException("Yeu cau khong hop le.");
        string op = Convert.ToString(payload["operation"]);
        string rel = payload.ContainsKey("relativePath") ? Convert.ToString(payload["relativePath"]) : "";
        string mode;
        if (op == "read_text" && rel == "chao-mung.txt") mode = "--gui-read";
        else if (op == "inspect_file" && rel == "chao-mung.txt") mode = "--gui-inspect";
        else if (op == "list_directory" && rel == ".") mode = "--gui-list";
        else if (op == "execute_terminal_command") mode = "--gui-deny-command";
        else if (op == "read_text" && rel == "../private.txt") mode = "--gui-deny-path";
        else if (op == "pac_native_verify") mode = "--gui-verify";
        else throw new InvalidOperationException("PAC chi cho phep tac vu mau co dinh.");
        var info = new ProcessStartInfo(WorkerPath);
        info.Arguments = mode;
        info.UseShellExecute = false;
        info.CreateNoWindow = true;
        info.RedirectStandardInput = false;
        info.RedirectStandardOutput = true;
        info.RedirectStandardError = false;
        // Minimize inherited environment, not an OS security boundary.
        info.EnvironmentVariables.Clear();
        foreach (string name in new[] { "SystemRoot", "WINDIR", "TEMP", "TMP", "PATH" })
        {
            string value = Environment.GetEnvironmentVariable(name);
            if (!String.IsNullOrEmpty(value)) info.EnvironmentVariables[name] = value;
        }
        // The broker constructs the AppContainer worker environment itself.
        using (var process = new Process())
        {
            process.StartInfo = info;
            if (!process.Start()) throw new InvalidOperationException("Khong khoi dong duoc worker.");
            if (started != null) started(process);
            try
            {
                Task<string> output = Task.Run(() => ReadBrokerOutputBounded(process));
                if (!process.WaitForExit(15000))
                {
                    process.Kill();
                    throw new TimeoutException("Native Broker vuot 15 giay va da bi dung.");
                }
                string wire = output.GetAwaiter().GetResult();
                if (wire.Length > 32768 || process.ExitCode != 0)
                    throw new InvalidOperationException("Worker loi hoac phan hoi qua lon.");
                Parse(wire);
                return wire;
            }
            finally
            {
                if (!process.HasExited)
                {
                    try { process.Kill(); } catch (InvalidOperationException) {}
                }
                if (started != null) started(null);
            }
        }
    }

    internal static string Request(string operation, string relativePath)
    {
        return new JavaScriptSerializer().Serialize(new Dictionary<string, object> {
            { "operation", operation }, { "relativePath", relativePath }
        });
    }

    internal static bool ValidateDemo(string workspace)
    {
        var read = Parse(Call(workspace, Request("read_text", "chao-mung.txt"), null));
        if (!(bool)read["ok"]) return false;
        var result = read["result"] as Dictionary<string, object>;
        if (result == null || !Convert.ToString(result["text"]).Contains("PAC-AppContainer-Bun-Allowed")) return false;

        var inspect = Parse(Call(workspace, Request("inspect_file", "chao-mung.txt"), null));
        var listed = Parse(Call(workspace, Request("list_directory", "."), null));
        var nativeProof = Parse(Call(workspace,
            "{\"operation\":\"pac_native_verify\"}", null));
        if (!(bool)nativeProof["ok"]) return false;
        var native = nativeProof["result"] as Dictionary<string, object>;
        if (native == null || !(bool)native["appcontainer"] ||
            !(bool)native["allowed"] || !(bool)native["denied"] ||
            !(bool)native["job"]) return false;
        var denied = Parse(Call(workspace,
            "{\"operation\":\"execute_terminal_command\",\"command\":\"whoami\"}", null));
        var traversed = Parse(Call(workspace, Request("read_text", "../private.txt"), null));
        return (bool)inspect["ok"] && (bool)listed["ok"] &&
               !(bool)denied["ok"] && !(bool)traversed["ok"];
    }
}

internal sealed class LabForm : Form
{
    private readonly string workspace;
    private readonly Label status;
    private readonly TextBox output;
    private readonly Button[] actions;
    private readonly object processLock = new object();
    private Process activeProcess;
    private bool working;

    internal LabForm(string fixture)
    {
        workspace = fixture;
        Text = "PAC Alpha Lab v0.3 — AppContainer Windows";
        StartPosition = FormStartPosition.CenterScreen;
        Size = new Size(920, 650);
        MinimumSize = new Size(800, 560);
        BackColor = Color.FromArgb(247, 249, 252);
        Font = new Font("Segoe UI", 10F);
        Icon = SystemIcons.Shield;

        var header = new Panel { Dock = DockStyle.Top, Height = 112, BackColor = Color.FromArgb(25, 57, 102) };
        var frame = new TableLayoutPanel {
            Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 4,
            Margin = Padding.Empty, Padding = Padding.Empty
        };
        frame.RowStyles.Add(new RowStyle(SizeType.Absolute, 112));
        frame.RowStyles.Add(new RowStyle(SizeType.Absolute, 58));
        frame.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        frame.RowStyles.Add(new RowStyle(SizeType.Absolute, 66));
        frame.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        Controls.Add(frame);
        header.Dock = DockStyle.Fill;
        frame.Controls.Add(header, 0, 0);
        header.Controls.Add(new Label {
            Text = "PAC  ·  ALPHA LAB v0.3", ForeColor = Color.White, Font = new Font("Segoe UI", 20F, FontStyle.Bold),
            AutoSize = true, Location = new Point(24, 14)
        });
        header.Controls.Add(new Label {
            Text = "AppContainer Windows · Worker quyền hạn chế · Chỉ dữ liệu mẫu.",
            ForeColor = Color.FromArgb(229, 237, 250), AutoSize = true, Location = new Point(27, 65)
        });

        var note = new Label {
            Dock = DockStyle.Top, Height = 58,
            Text = "APPCONTAINER LAB   |   Không truy cập tệp cá nhân   |   Chưa nghiệm thu bản sản xuất",
            Font = new Font("Segoe UI", 9F, FontStyle.Bold),
            ForeColor = Color.FromArgb(129, 81, 9), BackColor = Color.FromArgb(255, 245, 217),
            TextAlign = ContentAlignment.MiddleCenter
        };
        note.Dock = DockStyle.Fill;
        frame.Controls.Add(note, 0, 1);

        var bottom = new Panel { Dock = DockStyle.Bottom, Height = 66, BackColor = Color.White };
        bottom.Dock = DockStyle.Fill;
        frame.Controls.Add(bottom, 0, 3);
        status = new Label {
            Text = "● Sẵn sàng — chưa có tác vụ", Location = new Point(24, 20), AutoSize = true,
            ForeColor = Color.FromArgb(34, 115, 84), Font = new Font("Segoe UI", 10F, FontStyle.Bold)
        };
        bottom.Controls.Add(status);
        var close = NewButton("Đóng", 0, 0, 100, Color.FromArgb(76, 91, 112), delegate { Close(); });
        close.Anchor = AnchorStyles.Top | AnchorStyles.Right;
        close.Location = new Point(770, 12);
        bottom.Controls.Add(close);
        bottom.Resize += delegate { close.Left = bottom.ClientSize.Width - 124; };

        var left = new Panel { Dock = DockStyle.Left, Width = 245, Padding = new Padding(18) };
        var body = new TableLayoutPanel {
            Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 1,
            Padding = Padding.Empty, Margin = Padding.Empty
        };
        body.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 245));
        body.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        body.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        frame.Controls.Add(body, 0, 2);
        left.Dock = DockStyle.Fill;
        body.Controls.Add(left, 0, 0);
        left.Controls.Add(new Label {
            Text = "TÁC VỤ MẪU", Font = new Font("Segoe UI", 11F, FontStyle.Bold),
            ForeColor = Color.FromArgb(31, 51, 78), Location = new Point(20, 18), AutoSize = true
        });

        var buttons = new List<Button>();
        buttons.Add(NewButton("1. Đọc nội dung", 20, 62, 206, Color.FromArgb(42, 101, 180),
            delegate { Run("read_text", "chao-mung.txt"); }));
        buttons.Add(NewButton("2. Xem thuộc tính", 20, 119, 206, Color.FromArgb(42, 101, 180),
            delegate { Run("inspect_file", "chao-mung.txt"); }));
        buttons.Add(NewButton("3. Liệt kê thư mục", 20, 176, 206, Color.FromArgb(42, 101, 180),
            delegate { Run("list_directory", "."); }));
        buttons.Add(NewButton("4. Kiểm tra an toàn", 20, 233, 206, Color.FromArgb(36, 121, 96),
            delegate { RunSecurityCheck(); }));
        foreach (var button in buttons) left.Controls.Add(button);
        actions = buttons.ToArray();
        var stop = NewButton("Dừng tác vụ", 20, 316, 206, Color.FromArgb(166, 62, 62),
            delegate { StopWorker(); });
        left.Controls.Add(stop);
        left.Controls.Add(new Label {
            Text = "PAC không nhận đường dẫn hoặc câu lệnh bất kỳ trong bản Lab này.",
            ForeColor = Color.FromArgb(91, 102, 119), Location = new Point(20, 391),
            Width = 202, Height = 95
        });

        var content = new Panel { Dock = DockStyle.Fill, Padding = new Padding(16, 20, 23, 18) };
        content.Dock = DockStyle.Fill;
        body.Controls.Add(content, 1, 0);
        var contentTitle = new Label {
            Dock = DockStyle.Top, Height = 38, Text = "Kết quả thực hiện",
            Font = new Font("Segoe UI", 14F, FontStyle.Bold), ForeColor = Color.FromArgb(31, 51, 78)
        };
        content.Controls.Add(contentTitle);
        output = new TextBox {
            Dock = DockStyle.Fill, Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Vertical,
            Font = new Font("Consolas", 10F), BackColor = Color.White, ForeColor = Color.FromArgb(36, 49, 64),
            BorderStyle = BorderStyle.FixedSingle,
            Text = "Chọn một nút bên trái để xem PAC Worker xử lý dữ liệu mẫu." + Environment.NewLine +
                   Environment.NewLine + "Chế độ hiện tại: Native AppContainer Lab. Chưa kiểm thử Windows Home."
        };
        content.Controls.Add(output);
        output.BringToFront();
        contentTitle.BringToFront();
    }

    private Button NewButton(string caption, int x, int y, int width, Color color, Action action)
    {
        var button = new Button {
            Text = caption, Left = x, Top = y, Width = width, Height = 44,
            BackColor = color, ForeColor = Color.White, FlatStyle = FlatStyle.Flat,
            Font = new Font("Segoe UI", 10F, FontStyle.Bold),
            Cursor = Cursors.Hand
        };
        button.FlatAppearance.BorderSize = 0;
        button.Click += delegate { action(); };
        return button;
    }

    private void SetWorking(bool busy, string message)
    {
        working = busy;
        foreach (Button button in actions) button.Enabled = !busy;
        status.Text = message;
        status.ForeColor = busy ? Color.FromArgb(147, 89, 21) : Color.FromArgb(34, 115, 84);
    }

    private string FormatResult(string operation, string wire)
    {
        var parsed = LabWorker.Parse(wire);
        if (!(bool)parsed["ok"]) return "TÁC VỤ BỊ TỪ CHỐI: " + Convert.ToString(parsed["error"]);
        var result = parsed["result"] as Dictionary<string, object>;
        if (result == null) return "Kết quả không có dữ liệu.";
        if (operation == "read_text")
            return "ĐÃ ĐỌC NỘI DUNG MẪU\n\n" + Convert.ToString(result["text"]);
        if (operation == "inspect_file")
            return "THÔNG TIN TỆP MẪU\n\nLoại: " + result["kind"] + "\nDung lượng: " + result["size"] + " bytes";
        if (operation == "list_directory")
        {
            var names = new StringBuilder("DANH SÁCH TRONG WORKSPACE MẪU\n\n");
            var entries = result["entries"] as object[];
            if (entries != null)
                foreach (var entry in entries)
                {
                    var line = entry as Dictionary<string, object>;
                    if (line != null) names.AppendLine("• " + line["name"] + "  [" + line["kind"] + "]");
                }
            return names.ToString();
        }
        return "Đã thực hiện.";
    }

    private async void Run(string operation, string relative)
    {
        if (working) return;
        SetWorking(true, "● Worker đang thực hiện...");
        output.Text = "Đang xử lý tác vụ mẫu...";
        try
        {
            string reply = await Task.Run(() => LabWorker.Call(
                workspace, LabWorker.Request(operation, relative), SetActive));
            if (!IsDisposed) output.Text = FormatResult(operation, reply);
        }
        catch (Exception ex)
        {
            if (!IsDisposed) output.Text = "Tác vụ thất bại (an toàn):\r\n" + ex.Message;
        }
        finally
        {
            if (!IsDisposed) SetWorking(false, "● Sẵn sàng — worker đã kết thúc");
        }
    }

    private async void RunSecurityCheck()
    {
        if (working) return;
        SetWorking(true, "● Đang kiểm tra từ chối...");
        output.Text = "Kiểm tra lệnh cấm, đọc ngoài workspace và tác vụ hợp lệ...";
        try
        {
            bool ok = await Task.Run(() => LabWorker.ValidateDemo(workspace));
            if (!IsDisposed) output.Text = ok ?
                "ĐẠT: Worker đọc dữ liệu mẫu, kiểm tra tệp, liệt kê thư mục;\r\n" +
                "TỪ CHỐI: lệnh shell và đường dẫn vượt workspace.\r\n\r\n" +
                "ĐÃ KIỂM TRA: AppContainer token, Job Object, đọc được tệp cho phép, từ chối tệp chủ máy.\r\nLƯU Ý: Đây vẫn là bản lab, chưa nghiệm thu Windows Home hoặc mạng."
                : "KHÔNG ĐẠT: Một phép kiểm tra lab không thành công.";
        }
        catch (Exception ex)
        {
            if (!IsDisposed) output.Text = "KIỂM TRA THẤT BẠI:\r\n" + ex.Message;
        }
        finally
        {
            if (!IsDisposed) SetWorking(false, "● Sẵn sàng — đã kết thúc kiểm tra");
        }
    }

    private void SetActive(Process current)
    {
        lock (processLock) activeProcess = current;
    }

    private void StopWorker()
    {
        lock (processLock)
        {
            if (activeProcess != null)
                try { if (!activeProcess.HasExited) activeProcess.Kill(); }
                catch (InvalidOperationException) {}
        }
        if (!IsDisposed) status.Text = "● Đã gửi yêu cầu dừng worker";
    }

    protected override void OnFormClosed(FormClosedEventArgs e)
    {
        StopWorker();
        try { Directory.Delete(workspace, true); } catch (IOException) {} catch (UnauthorizedAccessException) {}
        base.OnFormClosed(e);
    }
}

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        string fixture = null;
        try
        {
            fixture = LabWorker.NewFixture();
            if (args.Length == 1 && args[0] == "--self-test")
            {
                Environment.ExitCode = LabWorker.ValidateDemo(fixture) ? 0 : 2;
                return;
            }
            if (!File.Exists(LabWorker.WorkerPath))
            {
                MessageBox.Show("Thiếu PAC-AppContainer-Broker.exe. Hãy giải nén đầy đủ bộ PAC Lab.",
                    "PAC Alpha Lab", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new LabForm(fixture));
        }
        catch (Exception ex)
        {
            Environment.ExitCode = 1;
            if (args.Length == 1 && args[0] == "--self-test")
                Console.Error.WriteLine("PAC_GUI_SELFTEST_FAILED: " + ex.Message);
            else
                MessageBox.Show("Không thể mở PAC Alpha Lab: " + ex.Message,
                    "PAC Alpha Lab", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
        finally
        {
            if (fixture != null && Directory.Exists(fixture))
                try { Directory.Delete(fixture, true); } catch {}
        }
    }
}
