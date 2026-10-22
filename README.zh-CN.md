# SLICC / gem5 Ruby Language Support for VS Code

[English](README.md) | 简体中文

**像编写 C++ 一样编写 gem5 Ruby 缓存一致性协议。**

为 gem5 Ruby 缓存一致性协议的 **SLICC 语言**提供 VS Code 编辑支持，识别 `.sm` 和 `.slicc`。当前版本 **0.3.0** 对齐 CLion 插件 **1.5.0** 的功能，以 JavaScript 独立实现，无需 Java、Python、gem5 构建或 npm 依赖。

原版 CLion / IntelliJ IDEA 插件仓库：[ilo5u/gem5-slicc-plugin](https://github.com/ilo5u/gem5-slicc-plugin)。

## 安装与使用

1. 从 [GitHub Releases](https://github.com/ilo5u/gem5-slicc-plugin-for-vscode/releases) 下载 `.vsix` 安装包。
2. 在 VS Code 扩展面板的 `…` 菜单中选择 **Install from VSIX… / 从 VSIX 安装…**，选中下载的文件。也可在下载目录运行 `code --install-extension slicc-0.3.0.vsix`。
3. 打开完整 gem5 仓库，然后打开 `src/mem/ruby/protocol` 下的协议文件。状态栏语言模式应为 **SLICC**。

仓库内的 `examples/Example.slicc` 是一个自包含的编辑功能示例；它不是可运行的 gem5 协议。在当前工程按 **F5** 可启动扩展开发宿主。

## 功能

| 功能 | VS Code 操作与行为 |
| --- | --- |
| 语法与语义高亮 | SLICC 保留字、属性、类型、machine、函数、action、字段、枚举常量及隐式变量 |
| 上下文补全 | `Ctrl+Space`；`.` 后只显示接收者的成员，支持 `interface` 继承、消息类型与引用/指针参数 |
| 协议索引 | 跟随 `.slicc` / `include` 和 `RubySlicc_interfaces.slicc`；区分 machine、类型和词法作用域 |
| 定义导航 | `F12` / `Ctrl+Click`；支持局部变量遮蔽、函数重载与跨文件声明/实现 |
| 双向导航 | 在 action 声明上跳到 transition；在函数实现或只有声明的函数上查看调用语句；在字段/枚举常量声明上查看使用语句 |
| 相关位置 | 命令面板或右键 **SLICC: Go to Related Transitions / Calls / Usages**，显示完整语句的单行预览并跳到标识符 |
| 查找引用 | `Shift+F12`，按符号身份和重载匹配，合并函数原型与实现的引用 |
| 参数与悬浮信息 | `Ctrl+Shift+Space` 或输入 `(` / `,`，保留 `&` / `*`，显示当前参数与重载 |
| 内联提示 | 参数名称；每个隐式 `in_msg` / `out_msg` / `tbe` / `cache_entry` / `address` 绑定首次使用时的类型 |
| 主缓存项类型 | 将隐式 `cache_entry` 解析为可见的 `AbstractCacheEntry` 实现，包括 CHI 的 `CacheEntry`；排除大小写不敏感的 `main="false"` 类型，缺失或含歧义时推迟判断 |
| 逻辑端口 | 将 `in_port` / `out_port` 解析为 `InPort` / `OutPort`；根据可见声明提供补全、导航、引用、参数提示、返回类型推断与成员检查 |
| 枚举默认值与生成函数 | 将非字符串 `EnumName_MemberName` 默认值导航到字段类型对应的枚举成员，将枚举/状态生成函数导航到生成它的声明 |
| 调试输出与内建函数 | 高亮并补全 `DPRINTF`、`DPRINTFN`、`APPEND_TRANSITION_COMMENT` 和返回 void 的 `stallPort`；仅在 DPRINTF 第一个参数处补全项目范围的 `DebugFlag` / `CompoundFlag` 名称 |
| 属性 | 在既有属性之外识别 `block_on`、`format`、`wake_up`、`rsc_stall_handler`、`prot_stall_handler`、`return_by_ref` 与 `return_by_pointer` |
| 格式诊断 | 字面量 DPRINTF/DPRINTFN 参数数量不匹配时报告警告；缺失/未知标志和缺失格式字符串仍报错；支持 `%%`、星号宽度/精度和嵌套调用中的逗号 |
| Transition 与调用诊断 | 按 include 展开顺序检查缺失 action 和后出现的重复 state/event 组合，支持混合列表分隔符、下一状态通配符与资源块；检查确定不可见的函数名 |
| 声明说明 | 悬浮显示所选符号自身的 `desc`，保留换行并转义标记；只在匹配的函数原型与定义之间回退查找说明 |
| 文件与符号图标 | 区分 `.sm` / `.slicc` 的文件图标，以及 SLICC Symbols 视图中的明暗主题声明徽标 |
| 问题诊断 | 未解析普通标识符、消息作用域错误、可确认的未知成员、函数结果赋值/实参类型冲突和 void 结果误用 |
| C++ 外部类型 | 在外部 SLICC 类型声明上跳到可达 C++ 类型/别名；遵循 `external_name`、命名空间、Ruby 构建源依赖与生成转发头文件映射 |
| 编辑辅助 | 大纲、`Ctrl+T` 符号搜索、折叠、注释切换、括号匹配与自动补全括号 |

VS Code 的 **Go to Declaration** 始终提供语义声明位置。**Go to Definition** 在声明名称处提供上述双向导航，这与原插件的交互方式一致。

`peek` 中的 `in_msg` 与 `enqueue` 中的 `out_msg` 使用最近匹配块的第二个参数作为类型，嵌套块继承外围绑定，显式参数/局部变量优先。共享文件可被多个 machine 引用；查找使用会遍历所有调用上下文。

action 内的 `cache_entry` 使用当前 machine/include 作用域中唯一的主 `AbstractCacheEntry` 实现。省略 `main` 时默认视为 true，`main="false"` 会排除该结构。导航、补全、重载推断和内联提示使用同一结果；显式局部变量和参数仍优先，默认类型缺失或含歧义时不会退回到无关的 `Entry`。

逻辑端口的接收者类型固定为 `InPort` 或 `OutPort`，声明的第二个参数仍是消息类型。`isReady`、`dequeue` 等方法通过 `RubySlicc_Types.sm` 中可见的 SLICC 声明解析；这两个名称也可以作为普通的用户方法或自由函数。参数、此前声明的局部变量和字段可以遮蔽端口；重复端口、含歧义的接收者类型或多个 machine 所有者会推迟解析。

非字符串枚举默认值在字段声明的枚举类型内解析，支持名称中含有下划线的情况。生成函数使用准确的生成类型标识符：全局 `EnumName_to_string`、machine 内的 `MachineName_EnumName_to_string`，以及状态函数 `MachineName_State_to_permission`。machine 内带有 `external` 或 `primitive` 属性的枚举/状态使用类型名称或 `external_name`，不加 machine 前缀。显式函数和变量优先；声明含歧义或不完整时推迟解析。

Transition 的 state、event 和 action 列表支持空白、逗号或分号分隔，也允许末尾分隔符。第三个参数可以是 `*`。单个花括号块属于 action 列表，包括空块或没有分号的列表；有两个块时，第一个为资源块。action 缺少右花括号时会保留语法错误，同时恢复后续声明的大纲与导航。

资源管理器中的 **SLICC Symbols** 视图使用原版明暗主题声明徽标展示当前文件。要启用蓝色 `SM` 与紫色 `H` 的独立文件图标，可运行 **Preferences: File Icon Theme / 首选项：文件图标主题** 并选择 **SLICC (gem5 Ruby)**。这个可选主题为其他文件和文件夹使用通用图标。原生大纲和补全列表保留 VS Code 标准符号图标；当前文件图标主题可能覆盖默认的语言图标。

## 配置

在设置中搜索 `SLICC`。常用设置：

```json
{
  "slicc.inlayHints.parameterNames": true,
  "slicc.inlayHints.implicitTypes": true,
  "slicc.diagnostics.members": true,
  "slicc.diagnostics.functionResults": true,
  "slicc.diagnostics.externalTypes": true,
  "slicc.diagnostics.printf": true,
  "slicc.diagnostics.transitions": true,
  "slicc.diagnostics.calls": true,
  "slicc.navigation.maxStatementLength": 160,
  "slicc.index.includePaths": []
}
```

`includePaths` 可填写工作区相对路径、绝对路径或远程目录 URI。索引默认排除 `.git`、`node_modules`、`build`、`dist` 和 `.venv`，可通过 `slicc.index.exclude` 调整。新增或修改文件会更新索引，也可手动执行 **SLICC: Rebuild Workspace Index**。

C++ 外部类型查询要求 Ruby 根目录包含 `Kconfig`、`SConscript` 与 `protocol/`，并沿受支持的字面量 `Source` / `MakeInclude` / `SLICC_INCLUDES` 和 C++ `#include` 路径查找。打开完整 gem5 仓库能让 Ruby 子树外的公共头文件参与解析。找不到源码上下文时报告警告；存在可读上下文但没有匹配定义时报告错误。

machine 所属的未限定外部类型优先查找唯一的 `gem5::ruby::<protocol>` 命名空间，再查找共享 `gem5::ruby`；非 machine 类型先查共享 Ruby。协议归属通过 `.slicc` 的字面量协议名和 include 链确定，并匹配 Kconfig 的 `RUBY_PROTOCOL_*` 后缀或将连续空白归一化后的 `bool` 提示。只有 machine 内发出的 include 才传播 machine 归属。协议未知或有冲突时仍尝试共享类型，若也不存在则报告警告；不会搜索其他协议。带命名空间的覆盖名称保留其明确限定。

调试标志补全读取当前项目或关联 gem5 仓库范围内的字面量 `DebugFlag` 和 `CompoundFlag` 声明，包括 `src/mem/SConscript` 中的 `HtmMem` 等非 Ruby 标志。此扫描独立于 C++ 构建图，不要求 Kconfig 注册。项目边界未知或来源扫描不完整时，仍补全已知名称，但只有完整扫描后才报告未知标志错误。`DPRINTFN` 直接接收格式字符串，不需要标志。脚本和未保存文档变化后会刷新缓存。只有格式参数数量不匹配改为警告；标志错误和缺少格式字符串仍报错。`APPEND_TRANSITION_COMMENT` 不检查格式参数数量。

## 开发与验证

需要 Node.js 18 或更高版本。无需执行 `npm install`。

```sh
npm run check
npm test
npm run test:corpus -- "<path-to-reference-repository>"
npm run test:vscode
```

`test:corpus` 读取指定仓库 HEAD 中的 Ruby 源码快照，检查真实协议解析、include、导航、内联提示、C++ 外部类型映射、调试标志，以及 MI_example、CHI 和 MOESI_hammer 的实际主缓存项。命令末尾可追加 Git 引用来固定发布快照，例如原插件仓库的 `v1.5.0`。还检查错误 action 块的恢复、全部 9 个端口方法、枚举默认值、CHI 的 `MN_TBEStorage` 命名空间，以及通过内存编辑验证 CHI 的 226 个 transition 的重复检测；详细结果写入 `.test/corpus-report.json`。支持原插件仓库的 `ruby/` 或 gem5 的 `src/mem/ruby/`，不改动源仓库。仅有 Ruby 子树的快照提供部分调试标志补全；非 Ruby 声明需要完整项目。

`test:vscode` 使用本机已安装的 VS Code，在 `.test/vscode/` 的独立用户目录与扩展目录中安装刚生成的 VSIX，再验证真实扩展宿主中的功能。可通过环境变量 `VSCODE_EXECUTABLE` 指定可执行文件；结果写入 `.test/vscode-report.json`。普通单元测试不启动 VS Code。

架构与功能对应关系见 [docs/architecture.md](docs/architecture.md)。

修改安装步骤、功能、配置、验证命令或分析边界时，请同步更新本文件与英文版 [README.md](README.md)。

## 分析边界

与原插件一样，不提供重命名重构、完整代码格式化、C++ 成员/调用解析或完整编译器类型检查。未知或不完整的类型、接口环、含歧义的声明、复杂运算和索引表达式会推迟相关类型诊断；成员名称诊断仅针对可可靠识别的简单接收者。函数结果检查不校验每个普通实参或函数体的 `return` 类型，也不模拟 C++ 隐式转换。

调试格式检查只校验参数数量，不校验参数类型；动态或不支持的格式及不完整调用会推迟检查。缺失函数诊断只检查名称，不检查实参兼容性。Transition 诊断需要无歧义且完整的 machine/include 展开上下文，集合重叠只在后出现的 transition 上报告。语法有误的文件保留主要语法错误，暂缓后续语义级联错误。

C++ 依赖图静态合并条件分支，不执行 Kconfig、SCons、预处理器或编译器。计算路径、宏生成的定义与复杂别名可能无法解析。扩展支持桌面 VS Code、Remote SSH / WSL 的工作区扩展宿主；不是浏览器 Web 扩展。

## 致谢

本 VS Code 插件的仓库分析、功能移植、代码实现、测试验证、文档编写及发布准备工作由 **OpenAI Codex（GPT-6）** 辅助完成。感谢 OpenAI 与 Codex 在上述工作中提供的帮助与支持。

## 许可

Apache-2.0，见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)。gem5 回归语料只从用户指定的本地仓库读取，不打包到扩展中。
