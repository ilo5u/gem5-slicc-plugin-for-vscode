# 验证记录

## 0.3.0 — 对齐 JetBrains 1.5.0

验证日期：2026-10-22。参考仓库 `C:/Users/chengxin/slicc-plugin` 的 `v1.5.0`
标签对应提交 `e54aa1b2986c6975cb87469c27d0bd2e6126c998`，本次回归固定在该标签。
原仓库保持只读，没有修改源文件。

- `npm run check`：27 个 JavaScript 文件及全部 JSON 配置通过。
- `npm test`：104 项核心测试全部通过，新增 40 项覆盖混合分隔列表、通配符、资源/action 区分、错误块恢复、端口方法与遮蔽、普通 `isReady` / `dequeue` 返回值、枚举默认值/生成函数、项目级调试标志、格式警告级别、协议命名空间与独立缓存。
- `npm run test:corpus -- C:/Users/chengxin/slicc-plugin v1.5.0`：按固定提交读取快照，避免后续 HEAD 更新改变本次发布验证的来源。
- 真实 VS Code 1.142.0 宿主的 41 项检查通过。测试安装生成的 0.3.0 VSIX，验证全部 9 个端口方法补全、参数提示、引用、枚举默认值跳转、生成函数跳转/高亮、非 Ruby 的 `HtmMem` 补全、格式警告及错误块恢复。未保存 `.slicc` 编辑从 CHI 切换为 Other 后，C++ 跳转随之改变，且继续复用同一个 C++ 构建图快照。
- 75 份真实语料解析出 11,824 个声明、生成 7,263 条内联提示；所有 include 可解析。MI_example、CHI、MOESI_hammer 的主缓存项选择继续通过。
- 真实 `MOESI_AMD_Base-Region-dir.sm` 保留原有缺失右花括号的语法错误，同时恢复全部 60 个 action、98 个 transition，以及 `wd_writeBackData` 的 14 处 transition 引用和正反向导航。
- 真实 `RubySlicc_Types.sm` 中的 InPort 7 个方法、OutPort 2 个方法全部参与解析；3 处非字符串枚举默认值解析到正确成员。
- CHI 的 `MN_TBEStorage` 从可达 C++ 源文件解析到 `gem5::ruby::CHI::MN_TBEStorage`。完整读取 226 个 CHI cache transition，在内存追加重复项后正确定位到后出现的 header；磁盘语料未改动。
- Ruby 子树快照提供 21 个已知调试标志，因为缺少完整项目边界而保守标记为不完整，不报告未知标志错误。完整项目与非 Ruby 标志扫描另由核心和宿主夹具验证。
- 语料剩余诊断为 184 条普通未解析标识符、原有 1 条语法错误、2 条格式参数数量警告。它们不是完整编译器的判断，逐文件信息保存在 `.test/corpus-report.json`。

当前宿主结果见 `.test/vscode-report.json`，可安装文件为
`dist/slicc-0.3.0.vsix`。英文 README 保持默认入口，并同步更新中文版及切换链接。
测试运行副本、报告、构建产物与本地配置继续由 Git/VSIX 规则排除。

下方保留旧版本验证记录。

## 0.2.0 — 对齐 JetBrains 1.4.0

验证日期：2026-10-21。参考仓库 `C:/Users/chengxin/slicc-plugin` 当前 HEAD：
`49089147f2db1a80201d3d97067e002eb59c6863`。仅作读取，没有修改原仓库。

- `npm run check`：24 个 JavaScript 文件及全部 JSON 配置通过。
- `npm test`：64 项核心测试全部通过，新增 33 项覆盖主缓存项选择、`main`、作用域、调试内建函数、格式参数计数、调试标志来源与缓存、transition 展开、缺失函数和 `desc` 说明。
- 真实 VS Code 1.142.0 宿主的 31 项检查全部通过，在独立测试目录中安装生成的 0.2.0 VSIX，验证原有编辑功能以及新功能，包括未保存 SConscript 编辑后的调试标志缓存刷新；明暗 SVG 路径和全部 16 个原版资源均参与安装包检查。
- 75 份真实语料解析出 11,673 个声明，生成 6,835 条内联提示；所有 include 可解析。
- 真实主缓存项断言通过：MI_example 为 `Entry`，CHI 为 `CacheEntry`，MOESI_hammer 目录侧为 `PfEntry`。原先 28 条成员名称诊断已消失。
- 从实际构建脚本读取 21 个调试标志。独立 Ruby 快照缺少必需的外部 Kconfig 依赖，因此标志来源标记为不完整，仍可补全已知名称，并暂缓未知名称错误。
- 语料剩余诊断：187 条普通未解析标识符、原有 1 条语法错误、2 条格式计数诊断和 1 条缺失函数诊断。这些观察不是完整编译器的判断，逐项信息保存在 `.test/corpus-report.json`。

图标采用 VS Code 平台支持的交互：默认语言图标、可选 **SLICC (gem5 Ruby)** 文件图标主题，以及 **SLICC Symbols** 视图的原版明暗声明徽标；原生大纲继续使用 VS Code 标准符号图标。

下方保留 0.1.0 的既有验证记录。该版本可安装文件为 `dist/slicc-0.2.0.vsix`。

## 0.1.0 — 既有验证

验证日期：2026-10-21。扩展版本：0.1.0。

## 核心与扩展宿主

- `npm run check`：17 个 JavaScript 文件及 JSON 配置检查通过。
- `npm test`：31 项核心测试全部通过，覆盖词法与位置、作用域、消息绑定、重载、类型继承、诊断、内联提示、引用、反向导航和 C++ 依赖图。
- `npm run test:vscode`：本机 VS Code 1.142.0 中的 21 项检查全部通过。测试先用 VS Code 的实际安装器安装生成的 VSIX，再从安装后的副本运行。

宿主检查包括语言注册、成员补全、隐式变量导航、函数和 action 双向导航、引用、参数信息、重载、大纲、工作区符号、折叠、语义高亮、内联提示、悬浮信息、干净示例诊断、C++ 类型跳转、工作区外 include 路径和未保存编辑后的诊断更新。

测试仅使用 `.test/vscode/` 下的独立用户资料与扩展目录。在受限运行环境中，系统安装的 Electron 运行目录未通过其 Windows 访问权限检查，因此本次宿主测试使用了工作区内的临时运行副本。清理命令被自动审批拒绝，当前策略不允许申请沙箱授权，因此该副本仍保留在 `.test/vscode-runtime/`；它被 Git 忽略，产品扩展不包含 VS Code 运行时。

## 原仓库的真实 gem5 语料

来源：`C:/Users/chengxin/slicc-plugin` 的 Git HEAD 快照
`5ae00dd111e5def7b2c9648e0381f378eefc599b`。没有修改该仓库。

- 75 个 `.sm` / `.slicc` 文件。
- 11,673 个解析声明，6,835 条可生成的内联提示。
- 所有 include 均可解析。
- MI_example 的 transition/action 导航、Entry 成员解析通过。
- CHI 拆分 include 文件的消息作用域验证通过。
- `MessageBuffer` 和 `CacheMemory` 均沿实际 Ruby 构建依赖找到 C++ 定义。
- 本机运行中，解析约 150 毫秒；包含全语料诊断、提示和 C++ 检查的核心处理约 1.1 秒。此数值不包含 Git 快照读取，也不是交互延迟保证。

语料验证不是“所有历史源文件零诊断”的断言。快照中的旧文件
`MOESI_AMD_Base-Region-dir.sm` 有 494 个左花括号、493 个右花括号，保留其真实语法错误并推迟后续语义级联错误。其他文件的静态分析合计产生 188 条未解析标识符和 28 条成员名称诊断；部分历史协议文件没有纳入当前 `.slicc` include 链，部分隐式 `cache_entry` 使用也超出声明中的 `Entry` 成员集合。测试没有把这些诊断默认为真实编译错误或全部误报，也没有通过跨协议同名搜索掩盖它们。

详细的逐文件观察保存在 `.test/corpus-report.json`；实际宿主检查结果保存在 `.test/vscode-report.json`。运行英文 [README.md](../README.md) 或中文 [README.zh-CN.md](../README.zh-CN.md) 中的命令可重新生成这两份报告。重命名、格式化及完整 C++/SLICC 编译器语义不在此次移植范围内，与原版已公开的功能边界一致。
