using System;
using System.Diagnostics;

// 7za 代理：electron-builder 的 app-builder 把 winCodeSign 压缩包里的 macOS 符号链接
// （libcrypto/libssl.dylib）解压失败判为致命，但其 Windows 打包根本不使用这些文件。
// 代理保持输出/退出码透传，仅把"解压命令(x)遇符号链接错误"的退出码 2 归零。
class Proxy {
  static int Main(string[] args) {
    var psi = new ProcessStartInfo {
      FileName = @"E:\OpenHarness\node_modules\7zip-bin\win\x64\7za.exe.bak",
      Arguments = string.Join(" ", args),
      UseShellExecute = false
    };
    var p = Process.Start(psi);
    p.WaitForExit();
    var isExtract = args.Length > 0 && args[0] == "x";
    var symlinkFailure = p.ExitCode == 2;
    if (isExtract && symlinkFailure) return 0;
    return p.ExitCode;
  }
}
