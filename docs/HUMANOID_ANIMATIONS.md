# 人形角色动画规范

所有玩家与人形 NPC 都应通过 `src/characters/HumanoidAnimations.js` 中的动作语义调用动画，不在控制器里写死 GLB 片段名。换模型时只需提供一个新的动画映射表。

## 海灵猎犬模型

资源：`public/models/characters/spectral-sea-hound.glb`

| 游戏语义 | 模型动画片段 | 用途 |
|---|---|---|
| `idle` | `Idle_3` | 默认空闲 |
| `walk` | `Walking` | 普通行走 |
| `run` | `Running` | 冲刺 |
| `climb` | `Fast_Ladder_Climb` | 梯子、桅杆攀爬 |
| `jump` | `Regular_Jump` | 起跳与腾空；`Leap_of_Faith` 可作为特殊跳跃 |
| `attack` | `Triple_Combo_Attack` | 近战攻击 |
| `helmGun` | `_01a163ba…`；回退 `Idle_3` | 开船、操作火炮时的单手持枪姿态 |
| `gunAim` | `_01a163bc…`；回退 `_01a163ba…` | 原地持枪瞄准 |
| `gunAimRun` | `Run_and_Shoot`；回退 `Running` | 持枪移动／跑动瞄准 |

新版源文件新增了明确命名的 `Run_and_Shoot`。两个站立持枪片段仍没有语义名称，因此继续通过可配置映射隔离；以后加入更准确的命名片段时，只修改角色 profile，不改玩家、NPC、船舵或火炮逻辑。

## 通用动作音频

`HumanoidActionAudio` 把角色事件映射到统一音频接口：`step()` 用于行走、奔跑和攀爬，`sword()` 用于近战命中，`gunshot()` 用于手持武器开火。玩家与 NPC 共用这套事件，不直接引用音频文件名。

## 右手装备插槽

`HumanoidEquipment` 读取每帧动画后的 `mixamorig:RightHand` 骨骼矩阵，让枪和剑精确跟随手掌位置与旋转。装备自身的握把偏移、尺寸和轴向集中配置在 `HumanoidAvatar.loadEquipment()` 中；其他 Mixamo 人形角色可直接复用，骨骼命名不同的模型只需增加一个手部别名。

## 复用方式

1. 用 `SkinnedModel` 加载带骨骼的 GLB。
2. 创建 `HumanoidAnimator(model, profile)`。
3. 控制器只调用 `set(HUMANOID_ACTION.WALK)` 等语义动作。
4. 一次性攻击使用 `attack()`；结束后状态机会回到当前移动或空闲动作。
5. 新人形模型提供同样的语义 profile，即可复用玩家与 NPC 行为。
