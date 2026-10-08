# dsh-extra-sandbox-presets

[English](README.md) | 简体中文

为 DeepSeek Harness 注册**任意数量的可配置权限预设**。每个预设自行选择一种沙箱模式与
一种审批策略，并声明在该模式原本允许的范围**之上**再额外可写的目录。

这覆盖了 harness 能表达的两种方向——`workspace-write` 预设打开会话工作区旁边的目录，
以及 `read-only` 预设只打开它列出的那些目录、此外一概不开——且每种都可以有任意多个。

三种自带沙箱模式未被改动：`read-only`、`workspace-write`、`danger-full-access`
的含义、持久化 schema 与升级阶梯全部保持原样。

## 新增了什么

每个已配置的预设都会在权限选择器里占一项。一个典型配置：

| 预设 | 沙箱模式 | 审批 | 可写范围 |
| --- | --- | --- | --- |
| `read-only` | `read-only` | `ask` | 无 |
| `workspace-write` | `workspace-write` | `ask` | 工作区 + 临时目录 |
| `workspace-write-extra` | `workspace-write` | `ask` | 上述范围 **+ 它配置的目录** |
| `scratch` | `read-only` | `never` | **只有它配置的目录** |
| `danger-full-access` | `danger-full-access` | `never` | 全部 |

预设是**权限预设**，不是第四种 `SandboxMode`。这个区分正是关键：沙箱模式是一组封闭的
三值联合类型，会被写入 `sandbox/mode` 会话事件，并在会话恢复时由多个外部投影重新校验。
若在那里加入第四个值，**所有用过它的会话都将无法读取**。把已有的模式与额外行为打包在
一起，正是自带的 `auto` 预设采用的做法。

生效范围是**逐会话**的：仅当该会话最后记录的权限预设是某个预设时，该预设的目录才生效；
由于该选择存在于会话日志中，重启后依然保留。

## 如何避免干扰

本插件不禁用、不替换、不重排任何自带行，而是**就地包装**两个正在运行的执行服务，
并在卸载时精确还原：

* 已挂载文件系统的包含性检查（`checkedTarget`）：当其拒绝发生时，针对当前预设授予的
  目录再重试一次；
* 沙箱 provider 的 `confine`：在 bwrap profile 中补上对应的 `--bind` 对。

fence 的重试**故意也覆盖 `read-only`**：自带 fence 在解析目标之前就直接拒绝 read-only
写入，因此包装会自行解析目标并与该预设的目录比较。这正是 `read-only` 预设也能授予写入
的原因，而它授予的恰好就是自己列出的那些目录。

模型可见的那段说明也需要同样修正，因为自带的 `sandbox:policy` 说明只按 mode 生成：
`read-only` 下它声称什么都不可修改，`workspace-write` 下它只点名工作区，而选中的预设
实际上还可能让更多目录可写。因此本插件监听 `system-prompt/assemble` 水波，把授予的目录
**就地**追加到那段说明之后。另起一个自己的 context 更简单，但它会与自带那句话并列而
互相矛盾；以同一个名字再注册一个 context 也不可行，因为 system-prompt 服务在同一层内
以名字为键，重名会被拒绝。

由此产生两个性质，两者都很重要：

* **失败是安全的。** 若本插件未能加载，harness 仍保有原有的文件系统与沙箱，而不会
  失去它们。（另一条路——禁用自带行再插入替换行——没有这种回退：Cordis 拒绝为同一
  服务名注册两个提供者，因此也无法靠遮蔽来获得安全性。）
* **它是叠加式的。** 自带检查对它原本已处理的每种情况仍具权威性，只有它自身的拒绝
  才会被重新考虑。

## 配置

两种方式都支持。

### profile 配置

```yaml
- id: extra-sandbox-presets
  name: dsh-extra-sandbox-presets
  config:
    presets:
      # 会话工作区，外加几个缓存目录。
      workspace-write-extra:
        writableDirs:
          - /srv/shared-assets
          - ~/notes
      # 完全不可写工作区；只有这两个目录可写。
      scratch:
        sandbox: read-only
        approval: never
        writableDirs:
          - /tmp
          - ~/scratch
      # 带自定义标签的一项：客户端显示 `name`，缺省则回退到预设键。
      rust-tools:
        sandbox: workspace-write
        writableDirs: [~/.cargo, ~/.rustup]
        name: Rust tools
        description: Workspace plus the cargo and rustup caches
```

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `sandbox` | `workspace-write` | `read-only`、`workspace-write` 或 `danger-full-access` |
| `approval` | `ask` | `ask` 或 `never` |
| `writableDirs` | `[]` | 在所选模式之上额外可写的目录 |
| `name` | 预设键 | 可选显示标签 |
| `description` | 无 | 可选单行描述 |

除非确实想要特定标签，否则不要给 `name`：缺省时选择器按预设键推导文字
（`workspace-write-extra` 显示为 `Workspace Write Extra`），而一旦提供标签，它会
**原样显示为英文**——因为客户端只为自己的内置预设做本地化。

目录必须是绝对路径；开头的 `~` 会被展开。符号链接会被解析，而**不存在或不是目录**的
条目会被**忽略并告警**，而不是被创建——授予一个没人指定的路径是危险的方向。展开是异步
的，因此某个目录只有在其自身展开成功之后才变为可写。若某个预设的 `sandbox` 或
`approval` 不是上述取值，它同样会被拒绝并告警，而不会被发布；保留名 `custom` 与
`auto` 也是如此。

预设顺序即配置顺序，也就是选择器展示它们的顺序。

### 设置页

`presets` 是 volatile 字段，因此整张表也会出现在设置页，编辑后对该 profile 内的所有
会话实时生效。设置页把它当作一整份文档来编辑，而非嵌套表单，因此上面的 profile patch
仍是书写它的自然位置。

## 与 harness 的兼容性

本插件不声明任何 `@deepseek-ai/dsh-*` 的 peer 范围，而 harness 只检查这类 peer。
因此它的兼容性建立在更精确也更狭窄的东西上：**两个已挂载服务的形状**（外加一个事件名
与一个 context 名）。这个形状才是代码实际使用的东西，其中服务部分由
`test/contract.test.ts` 对**真实类**加以固定——所以任何移动了它的 harness 升级都会
立刻让测试失败，而不是在生产环境里悄悄收窄某个预设。

| 依赖 | 使用处 |
| --- | --- |
| `fs.checkedTarget(target, policy)` 以错误码 `FS_SANDBOX_DENIED` 拒绝 | `src/fs.ts` |
| `fs.resolve(path)` 解析出带 `targetKey` 的 target | `src/fs.ts` |
| `sandbox.confine(argv, policy, signal)` 解析为带 `argv` 的对象 | `src/provider.ts` |
| policy 的 `mode`、`sessionId` 字段；结果的 `argv` 字段 | 两个包装 |
| `permissionPresets.presets` 与 `emitCatalogChanged()` | `src/service.ts` |
| `system-prompt/assemble` 水波，以及其中要修正的 `sandbox:policy` context | `src/service.ts` |

有两个性质让它在升级中保持稳健：

* 包装通过 `await` 调用自带方法，因此自带方法在同步与异步之间变化仍可工作。
* 两个包装都在**返回的对象**上操作，而不假设它是裸 argv，因此返回值新增字段仍可工作。

当某个已挂载服务完全不暴露预期的接缝时，插件会**每个服务告警一次**，并保持该实例
不变。它从不禁用自带行，因此任何意外 harness 形状下的失败模式都只是日志告警加自带
行为——绝不会变成文件系统或沙箱缺失。

## 平台支持

* **Linux + `bwrap`** —— 完全支持。配置的目录以 `--bind <dir> <dir>` 加入 bubblewrap
  profile，因此受限命令与 write/edit 文件工具的行为一致。
* **Linux + `landlock`，以及 macOS `seatbelt`** —— write/edit 文件工具会被放宽，
  但受限命令不会，因为那些 profile 构建在本插件无法扩展的包内部。此时会告警一次，
  而不是假装支持。
* **Windows** —— 不支持。

## 文件结构

| 文件 | 作用 |
| --- | --- |
| `src/service.ts` | `ctx.sandboxPresets`：持有已配置的预设表、按会话判定哪个预设生效、包装两个执行服务、发布预设，并在装配水波上修正自带沙箱说明。 |
| `src/presets.ts` | 归一化配置的预设表，并展开每个预设的目录。 |
| `src/fs.ts` | 包装运行中文件系统的包含性检查。 |
| `src/provider.ts` | 包装运行中沙箱 provider 的 `confine`。 |
| `src/roots.ts` | 路径展开与包含性判定。 |
| `src/plan.ts` | 纯函数式的 bwrap argv 变换。 |
| `cordis.patch.yml` | 插入唯一的一行插件。 |
| `test/contract.test.ts` | 固定本插件所扩展的 harness 接缝。 |

`lib/` 是 `src/` 的编译产物（`tsc -p tsconfig.build.json`），已被 git 忽略：它是构建
产物，`src/` 才是唯一事实来源。`prepare` 负责构建它，所以在仓库内执行 `pnpm install`
即可产出 `lib/`。请改 `src/`，永远不要改 `lib/`。

注意 profile 以**符号链接**（`link:`）安装本包并指向当前工作树，而 pnpm 不会为 `link:`
依赖执行生命周期脚本——所以经由 profile 安装并不会触发构建。请在仓库内构建，链接进来的
profile 会直接使用 `lib/` 当前的内容。

## 构建

```
pnpm run build      # tsc -p tsconfig.build.json -> lib/
pnpm run typecheck  # tsc -p tsconfig.json (src + test)
```

## 测试

```
node --test test/
```

`src/roots.ts`、`src/plan.ts`、`src/presets.ts` 与两个包装都不依赖外部包，随处可运行。契约套件
与集成套件需要 DSH 包可被解析，因此需在已安装的 profile 中运行：契约套件固定真实的原生
接缝，集成套件则装配真实的文件系统与沙箱 provider，断言放宽生效以及卸载时的精确还原。
所有需要这些包的套件在包缺失时会带原因跳过，绝不空过。测试针对编译产物 `lib/`，所以
请先运行 `pnpm run build`。
