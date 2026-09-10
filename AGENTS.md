# AGENTS.md

dsh-model-pricing 是 dsh-tokbook 记账本的**自托管价格镜像**,带显式的 per-provider
(计费通道)维度:同一模型经不同通道可以按量计费或属于订阅。仓库维护两层数据 ——
`model_pricing.json`(模型基础价目表:照抄上游社区 feed,含每个模型的 `timeRules`
调价史、context 档位等)与 `provider_pricing.json`(per-provider 覆盖层:每个 provider 组
携带**通道级** `billing` 计费类别,条目 `inheritBase` 跟随基础表某模型的完整价格史,
或用 `segments[]` 表达通道自己的时间线)。

本文件让 agent 的行为与本仓库的实际运作方式对齐。更具体的指示优先;动手前先读
README 与本文件提到的文件。

## 与维护者的协作方式(常设偏好)

本仓库与 dsh-tokbook 同属一位维护者,以 AI 辅助开发。除非我在具体任务里另行说明,
以下三条是每个任务的默认(同 dsh-tokbook AGENTS.md):

1. **动手前先澄清意图——不要猜测。** 我提出任务时,先分析我的意图:我想要的结果、
   适用的约束。如果有影响实质的不清晰点——范围、目标、取舍、"完成"的样子——直接
   向我提问,确保我们认知同步后再改动任何东西。只有机械、无歧义的工作可以不问直接做。

2. **从第一性原理出发思考。** 从底层目标与本仓库内真实的事实(代码、数据、约束)出发,
   而不是套用熟悉的套路或习惯。说明你的假设;对继承来的选择——包括此前 AI 的决定与
   文档——如果它已不值得保留,敢于质疑并明说,而不是默默照做。

3. **单人维护 + AI 辅助——不做过度防御性设计。** 优先选择满足需求的最简设计。不添加
   投机性结构:为未必到来的未来做的抽象、为没发生过的场景写的防御代码、没人要的配置
   开关、超出需要的检查。因真实原因存在的不变量(双层结构、metered 与 subscription
   分开、inheritBase 与 segments 互斥)保留;不为没人要求的新场景新增。

> 维护者原话:① 先分析意图;不清晰时**不要猜测,向我提问**,确保认知同步;
> ② **从第一性原理出发**思考;③ 单人维护 + AI 辅助开发,**不做过度防御性设计**。

## 命令

没有 package.json、依赖与构建工具链——只有一个零依赖的 Node ESM 脚本:

| 命令 | 作用 |
| --- | --- |
| `node scripts/build.mjs` | 从默认本地 mirror(`$DSH_HOME/tokbook/pricing.ccsa.json`,依次回退到 `~/.dsh/tokbook/…`)重写三个生成物 |
| `node scripts/build.mjs <path>` | 指定本地 mirror(如刚重新同步、更新的 `pricing.ccsa.json`) |

脚本只读本地、**从不联网**;找不到「含非空 `models`」的可用 mirror 就报错退出。
它在落盘前会先校验 `providers.source.json`(形状、通道 `billing` 枚举、重复条目、
segments 顺序与首段/末段铺满、`inheritBase` 目标是否能在基础表中解析),有问题则列明
并以非零码退出。内容没变的生成物不重写,所以空跑一次 build 后 `git status` 保持干净。

## 改什么 / 不改什么

- **定价事实的唯一手编源是 `providers.source.json`**——加/改/删通道与
  `(provider, model)` 条目都改这里。
- `model_pricing.json`、`provider_pricing.json`、`BASE_SOURCE.json` 是**生成物**:
  由 build 重写。不要手改——会被下次 build 覆盖;但**要随改动一起提交**,因为本仓库
  即分发渠道,消费方经 raw URL 从这里拉取(这与 dsh-tokbook 的 `lib/` 相反)。
- 基础价目表**零发明**:逐字拷贝自本地 tokbook mirror,保留上游 `version` /
  `updatedAt` 原样(消费方靠它们决定是否重新拉取)。模型厂商调价 = 重新同步 tokbook
  mirror 后重跑 build;脚本本身不造数、不联网。
- 改语义(条目机制、计费类别、字段)时,把三处一起改:build 里的校验/编译逻辑、
  `provider_pricing.schema.json`、`providers.source.json` 的 `version`(整数递增)。
  只有 schema/语义变化才提升 `version`,普通加条目不用。

## 数据规则(编辑 providers.source.json 时必须遵守)

- `provider` 必须是**记账本里实际记录的 route key**(如 `deepseek-official`、
  `opencode-go`、`commandcode`、`zai`、`staryears`、`dots-ai`、
  `modlens-commandcode`、…);`entries[].model` 是**该 provider 下记录的确切模型
  字符串**——可能带 provider 前缀(如 `deepseek/deepseek-v4-flash`),基础表本身
  匹配不了。改 key/字符串前先核对 dsh-tokbook 账本里的真实记录。
- **`modlens-*`（含 `deepseek-modlens`）是包装 id，不是独立通道**：客户端插件给上游路由
  mint 的合成孪生——同上游通道方、同 `billing`、同 `inheritBase` 目标，绝不单独定价；
  只要账本里还有该 id 的记录就保留条目（丢了会让那些历史调用变成未定价）。镜像层没有
  route alias 字段，包装路由靠**复制上游条目**表达；条目多到复制不划算时再考虑加别名字段
  （需消费方配合）。术语界定见 README 的「术语」一节。
- **建条目的判据是「可能在账本里出现 + 价格已知」,不是「账本已经记录过」**:价格已知 =
  有官方价可跟(`inheritBase`)**或**有通道自己的已知费率(`segments`,含**确实免费**的
  ¥0——免费是已知的价,不是未知价)。按该通道可服务的模型目录预置(订阅目录里用户随手能
  选到的模型也要有,否则一换模型就被报未定价),同时覆盖账本已记录的确切串。价格**未知**的
  串不建条目(让消费方报未定价,好过用 ¥0 伪装免费)。
- 每条 entry 二选一(互斥,校验会拦):`inheritBase: <modelId>`(跟随基础表该模型的
  **完整**价格史——官方通道、按官方价折算的订阅通道、placeholder 中继都用它)或
  `segments[]`(通道自带时间线:首段从 0 起、末段开放式,build 强制;只支持平铺价,
  峰谷/上下文档位表达不了——那类通道用 `inheritBase`)。
- `billing` 挂在 **provider 组**上(通道属性,覆盖其全部条目);条目级 `billing` 只用于
  混合通道的覆盖(判据:同一通道内既有套餐内不按量计费的模型、又有真实按量扣费的模型;
  当前数据未使用)。`metered` = 真实按量花费(可计入实际支出);`subscription` = 订阅内的
  价值折算——**绝不可混入实际支出合计**。
- `note` 只写定价依据与口径(为什么这么定价、跟随哪个 id、折扣段),不写会随使用变化的
  数字(账本行数、请求数)。
- `inheritBase` 目标必须在当前基础表(或其 aliases)解析得到,否则 build 直接抛错。

## 背景文档

- `README.md` — 端到端范围、双层结构、术语界定(模型厂商 vs 通道方、包装 id)、schema
  要点、维护与接入方式。最先读它。
- `provider_pricing.schema.json` — provider 层输出结构的权威 schema。
- 上游基础价目表的 schema:见 LaoYueHanNi/model-price-table 的 README。
- 消费方 `dsh-tokbook`(Desktop 下的兄弟仓库)——provider key、model 字符串与计费
  语义必须和它的账本记录对齐。

本仓库 README 与 `providers.source.json` 的 note 用中文(主要用户是中文用户);
`provider_pricing.schema.json` 用英文(机器可读产物的描述)。跟随每个文件既有的语言,
不混写。文档会过时——与代码冲突时以代码为准并修文档。

## 保持本文件精简

本文件每次请求都会载入上下文,所以刻意保持最小。只适用于单一领域的指引应放进上面
链接的文件,而不是这里——加面包屑,不要加规则。
