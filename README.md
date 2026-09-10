# dsh-model-pricing

dsh-tokbook 记账本用的**自托管价格镜像**，带显式的 **per-provider（计费通道）**维度 ——
同一模型经不同通道可以计费方式不同（按量 API vs. 订阅内不按 token 计费）。

本仓库把两层数据分开维护：

| 文件 | 层 | 形状 | 消费方 |
|---|---|---|---|
| `model_pricing.json` | **模型基础价目表**（RMB / 每百万 token） | 与上游维护的社区 feed 完全一致（`modelId` + 4 项费率 + 时间规则 / 上下文档位 / 峰谷时段 + aliases） | 只认模型 id 的既有消费方无需改动 |
| `provider_pricing.json` | **per-provider 覆盖层** | `providers[]`（`provider`、`billing: metered\|subscription`、`entries[]`）→ 条目（`model`、`inheritBase` \| `segments`） | dsh-tokbook 按 `(provider, model)` 取价的路径 |

`BASE_SOURCE.json` 记录当前基础价目表的来源（取自哪个本地 mirror、上游 version /
updatedAt、构建时间）。

## 术语

本仓库的每条事实都挂在**两个彼此独立的角色**上。同一条记录里，「模型是谁做的」和
「这条路怎么走、怎么计费」通常属于不同的一方，所以用词必须分开：

| 术语 | 指什么 | 落在哪 |
|---|---|---|
| **模型厂商**（model vendor / 上游厂商 / 模型方） | 开发并拥有模型，定义官方费率与调价史的一方 | `model_pricing.json`（基础表） |
| **通道**（channel / provider / 计费通道） | 模型被接入并被计费的一条路径 —— `provider` route key | `provider_pricing.json` / `providers.source.json` |
| **通道运营方**（channel operator） | 运营某条通道的一方：官方通道就是厂商自己，其余是第三方 | `providers[].label` |
| **官方通道**（official / first-party / 直连） | 厂商自营的按量 API（`deepseek-official`、`zai`） | `metered` + `inheritBase` |
| **中转 / 转售商**（reseller / relay） | 第三方按量通道，用自己的价、可能带加价（`staryears`） | `metered`；拿到真实中转价后改 `segments[]` |
| **订阅套餐**（subscription plan / 套餐运营方） | 模型访问被打包进套餐，调用不按 token 计费（`opencode-go`、`commandcode`） | `subscription` + `inheritBase` |
| **包装路由**（wrapper / alias route） | 客户端插件为既有通道 mint 的合成孪生，形如 `<插件>-<provider>`（`modlens-commandcode`、`deepseek-modlens`） | 沿用被包装通道的 `billing` 类别与 `inheritBase` 目标 |

由此有两条必须守住的结论：

- **`provider` 从不等于模型厂商。** 一条 `(provider, model)` 条目说明的是「一条通道 +
  一个模型」；模型由谁开发是另一个问题，其官方费率只存在于基础表。
- **角色属于通道，不属于公司。** `deepseek-official` 是 DeepSeek 自己兼任通道运营方；
  `commandcode` 销售 DeepSeek 系列模型但并不因此成为 DeepSeek。同一家公司可以同时
  占两个角色，所以说的时候要指明角色，而不是只报公司名。

## 为什么分两层

- **基础表是社区 feed 的副本**（tokbook 同步的同一份），所以本仓库从真实、可审计的
  模型费率出发，且对只认模型 id 的消费方是 drop-in 的。
- **provider 层是上游没有的部分。** 账本里的一条通道（如 `opencode-go`、`commandcode`）
  可能是：
  - **`metered` 按量** —— 每百万 token 计费，按基础费率或通道自己的 `rate`（中转/转售
    会加自己的价差）；或者
  - **`subscription` 订阅** —— 模型包含在套餐内，调用不按 token 计费，所以账本不该给
    它们编一个费率来算钱。

按 `(provider, model)` 取价时**先查 provider 层**，该 provider 没有条目时回落到模型
基础表。

### 时间维度 —— 价格会变

两层都带**时间维度**。基础表的每个模型条目已经包含厂商自己的调价史，即 `timeRules`
（例如 `deepseek-v4-flash` 有 原价 → 每日峰谷 两段；`glm-5.3-flash` 有限时 5 折窗口）。
provider 层的条目则解析为两种机制之一：

- **`inheritBase: <modelId>`** —— 该通道跟随基础表这个模型的**完整**价格史（每一条历史
  与当前的时间规则、上下文档位、峰谷时段）。官方通道、按官方价折算的订阅通道、以及
  中转占位都走这条，于是**厂商调价时只需改一次基础表，所有跟随的通道都会正确重算历史**。
- **`segments[]`** —— 该通道有**自己的**价格时间线（中转的真实价格，或人工定价的未知
  模型）。每段是 `{ from?, to?, rate, note? }`；各段铺满整条时间线，首段默认 `from: 0`，
  末段应开放式。

### 计费类别 —— 求和时必须分开

计费方式是**通道**的属性，所以 `providers[].billing` 承载它并作用于该通道的全部条目；
混合通道可以用条目级 `billing` 覆盖：

- **`metered`** —— **真实**的按 token 花费：真正扣钱的官方/中转 API。把 `metered`
  行相加得到的是实际支出。
- **`subscription`** —— 模型包含在套餐内，调用不按 token 计费。它的价值等于这些调用按
  官方/按量费率折算要花多少钱 —— **不是实际支出**。消费方**绝不能**把 `subscription`
  行混进实际支出合计，只能把它作为订阅价值单独呈现。

构建会自动解析四种来源约定：

1. **官方/直连通道**（`deepseek-official`、`zai`、…）—— `metered` + `inheritBase`：
   按官方价真实支出，并跟随其调价史。
2. **中转/转售通道**（`staryears`、…）—— `metered`，当前是 `inheritBase` 且
   `placeholder: true`（按官方价占位）。要填中转的**真实**价格史，就把 `inheritBase`
   换成 `segments[]`（每段带中转自己的费率）。
3. **订阅通道**（`opencode-go`、`commandcode`、…）—— `subscription` + `inheritBase`：
   它们创造的价值就是官方价（跟随其调价史），永远不是实际支出。
4. **价格未知的模型字符串** —— **完全不建条目**。消费方会把它报为*未定价*（¥0，列进它的
   `unpricedModels`），这才是诚实表达「不知道价格」；用一条 ¥0 的 `segments` 冒充，则
   看起来像免费模型。区别在于**是否知道**：确实免费（免费 deal）属于已知的 ¥0，照常建
   `segments` 条目；不知道价格才留空。

### 包装路由（`modlens-*`）不是独立通道

账本记录的是请求实际走过的通道，而客户端插件可以为它包装的通道 mint 自己的 id。
modlens 视觉桥就是这么做的：它把 `modlens-<provider>`（`deepseek-official` 则是
`deepseek-modlens`）注册成该 provider 的合成孪生，带相同的模型 id，每次调用都回落给
上游 —— 它是给**自己看不了图**的模型搭的桥；有视觉能力的模型被刻意排除在包装之外。
所以 `modlens-commandcode` 与 `commandcode` 是同一个运营方、同一个套餐、同一批模型，
只有记录下来的 id 不同。

对本仓库而言这意味着：

- **绝不单独给包装路由定价。** 它的条目沿用被包装通道的 `billing` 类别与同一个
  `inheritBase` 目标，于是厂商调价仍然只需改一次基础表。
- **只要账本里还有该 id 的记录，就保留条目。** 消费方按 route key 解析
  `(provider, model)`，删掉条目会让那些历史调用变成*未定价*。
- **包装 id 是来源标记，不是另一笔购买。** 它证明这次调用走的是它的上游通道，本身不会
  引入第二笔费用。

镜像层**没有** route alias 字段（消费方的 route→canonical 别名只存在于它自己的手工覆盖
层），所以包装路由目前靠**复制上游条目**来表达。当某个包装路由需要镜像的条目多到复制不再
划算时，才值得考虑在镜像层引入别名字段 —— 那需要消费方配合，属于跨仓库改动。

## 目录结构

```
model_pricing.json          生成物 —— 基础表（逐字拷贝自本地 mirror；
                            携带每个模型的 timeRules 调价史）
provider_pricing.json       生成物 —— provider 层（通道 billing + 条目级
                            inheritBase 或显式 segments 时间线）
providers.source.json       手工编辑 —— 每条通道的事实清单（改这里）
provider_pricing.schema.json            —— provider 层的 schema
scripts/build.mjs           生成器：基础表拷贝 + provider 层编译
BASE_SOURCE.json            当前基础表的来源记录
```

## 维护

所有定价事实的编辑都发生在 **`providers.source.json`**（通道清单：哪个
`(provider, model)` 是 metered/subscription，以及任何通道专属费率）。重新生成产物：

```sh
node scripts/build.mjs                     # 用 $DSH_HOME/tokbook/pricing.ccsa.json
node scripts/build.mjs /path/to/pricing.ccsa.json   # 或指定某个 mirror
```

基础表只靠「对更新的已同步 mirror 重跑」来刷新 —— 脚本从不发明模型费率，也从不联网。
源文件没变的重新构建会让每个产物逐字节不变（时间戳的含义是「最后一次内容变更」），
所以 `git status` 只会显示真实编辑。

## 数据结构（Schema）

- `model_pricing.json`：见上游 feed 的 schema（LaoYueHanNi/model-price-table 的 README）。
  金额一律是 RMB / 每百万 token。
- `provider_pricing.json`：见 `provider_pricing.schema.json`。核心规则：
  - `providers[].provider` 必须匹配**账本里记录的** provider route key
    （`deepseek-official`、`opencode-go`、`commandcode`、`modlens-commandcode`、`zai`、
    `staryears`、`dots-ai`、…）。
  - `providers[].billing` 是**通道的**计费性质，作用于其全部条目；条目级 `billing` 为
    混合通道提供覆盖。`metered` = 真实支出，`subscription` = 按解析出的费率折算的套餐
    价值（永远不是实际支出）。
  - `entries[].model` 是**该 provider 下记录的确切模型字符串** —— 可能带 provider 前缀
    （如 `deepseek/deepseek-v4-flash`），这是基础表单独匹配不了的。
  - `inheritBase: <modelId>`（跟随基础表该模型的完整价格史）与 `segments[]`（通道自己的
    时间线：首段从 0 起、末段开放式、只支持平铺费率 —— 表达不了峰谷或上下文档位）
    **二选一**。
  - `placeholder: true` 标记中转条目：它的官方价是占位，等填入真实 `segments` 为止。
  - provider 层**不带** `usdExchangeRate`：汇率是基础 feed（`model_pricing.json`）的单一
    事实源，消费方只从那里读；两层各存一份只会得到同一标量、两个时间戳。

## 让 dsh-tokbook 指向本镜像

dsh-tokbook 已经按 `(provider, model)` **provider 优先**解析，而本仓库的 provider 层就是
它默认的 `pricingProviderUrl`。要用 fork 或自托管 raw URL，显式指向两层：

```yml
plugins:
  tokbook:
    pricingUrl: https://raw.githubusercontent.com/<you>/dsh-model-pricing/master/model_pricing.json
    pricingProviderUrl: https://raw.githubusercontent.com/<you>/dsh-model-pricing/master/provider_pricing.json
    # pricingRegion: domestic   # 或自托管的 gitee raw URL
```

## 状态

- [x] 仓库 + 双层结构、schema、生成器、来源记录
- [x] 基础表逐字取自当前已同步的 mirror（185 个模型）
- [x] provider 层按**各通道可服务的模型目录**预置条目（账本尚未记录的也预置 —— 用户随时
      可能切到某个模型，不预置就会立刻显示成未定价），并覆盖账本里已记录的确切
      `(provider, model)` 串：官方/直连通道跟随官方调价史（`inheritBase`），订阅通道按
      官方调价史折算价值（通道 `billing: subscription` + `inheritBase`），中转通道按官方
      调价史占位（`placeholder: true`），价格未知的字符串不建条目（由消费方报为未定价）
- [x] 时间维度：provider 条目要么跟随基础表的 `timeRules` 调价史，要么自带显式
      `segments` 时间线 —— 厂商调价后无需逐通道重编即可重算历史
- [x] dsh-tokbook 消费方按 `(provider, model)` provider 优先解析，按每条记录的时间戳
      跟随 `inheritBase`/`segments` 时间线，并且在求和时把 `metered`（实际支出）与
      `subscription`（套餐价值）分开 —— 成本界面把两者显示为两个独立数字
