# 人形角色动画规范

所有玩家与人形 NPC 都应通过 `src/characters/HumanoidAnimations.js` 中的动作语义调用动画，不在控制器里写死 GLB 片段名。换模型时只需提供一个新的动画映射表。

## 幽灵船长模型

资源：`public/models/characters/ghost-captain.glb`（网格使用 Draco 压缩，原始 4K 纹理保持不变）

| 游戏语义 | 模型动画片段 | 用途 |
|---|---|---|
| `idle` | `Idle_3` | 默认空闲 |
| `walk` | `Walking` | 普通行走 |
| `run` | `Running` | 冲刺 |
| `climb` | `Fast_Ladder_Climb` | 梯子、桅杆攀爬 |
| `jump` | `Regular_Jump` | 普通跌落连续悬空超过 1 秒后的腾空姿势；1.6 倍速播放 |
| `runJump` | `Jump_Over_Obstacle_2` | 高速移动中主动跳跃；回退 `Regular_Jump` |
| `attack` | `Triple_Combo_Attack` | 近战攻击 |
| `helmGun` | `_01a163ba…`；回退 `Idle_3` | 开船、操作火炮时的单手持枪姿态 |
| `gunAim` | `_01a163bc…`；回退 `_01a163ba…` | 原地持枪瞄准 |
| `gunAimRun` | `Run_and_Shoot`；回退 `Running` | 持枪移动／跑动瞄准 |
| `swimIdle` | `Swim_Idle` | 水中静息、漂浮 |
| `swim` | `Swim_Forward` | 水面与水下游动 |
| `turnLeft` | `Idle_Turn_Left` | 静止时向左原地转身 |
| `turnRight` | `Idle_Turn_Right` | 静止时向右原地转身 |

两个站立持枪片段仍没有语义名称，因此继续通过可配置映射隔离；以后加入更准确的命名片段时，只修改角色 profile，不改玩家、NPC、船舵或火炮逻辑。

## 状态切换规则

- 短暂离地、跨台阶和甲板颠簸维持当前移动动画；只有普通跌落连续悬空达到 1 秒才进入 `jump`。
- 高速移动中主动按下跳跃立即进入 `runJump`，不受上述 1 秒防误触阈值限制。
- 静止时身体与镜头朝向相差超过约 0.1 弧度，会按方向播放 `turnLeft` 或 `turnRight` 并平滑对齐；移动时由 `walk` / `run` 接管朝向。
- 进入游泳状态后，静止使用 `swimIdle`，产生有效水平速度后使用 `swim`。水面划水会产生速度相关的水滴与白色飞沫，完全潜水时关闭水面飞沫。
- 游泳模型根节点会下沉到水面以下并启用完整水下光照，避免角色像站在水面上或潜水时消失。

## 角色镜头

人物模式按 `V` 在第一与第三人称间切换。第三人称在用户停止转动镜头后才缓慢跟到人物身后；移动参考方向会在一次按键期间锁定，避免镜头自动回正导致角色绕圈。

第一人称采用全身可见方案：镜头跟随头部骨骼，并沿身体正前方移动约 0.28 米，使近裁剪面位于脸部网格之外。角色本体不会被隐藏，因此低头能看到胸口、手臂、装备和腿，水下也保持可见。

## 通用动作音频

`HumanoidActionAudio` 把角色事件映射到统一音频接口：`step()` 用于行走、奔跑和攀爬，`sword()` 用于近战命中，`gunshot()` 用于手持武器开火。玩家与 NPC 共用这套事件，不直接引用音频文件名。

## 右手装备插槽

`HumanoidEquipment` 读取每帧动画后的 `mixamorig:RightHand` 骨骼矩阵，让枪和剑精确跟随手掌位置与旋转。装备自身的握把偏移、尺寸和轴向集中配置在 `HumanoidAvatar.loadEquipment()` 中；其他 Mixamo 人形角色可直接复用，骨骼命名不同的模型只需增加一个手部别名。

## 复用方式

1. 用 `SkinnedModel` 加载带骨骼的 GLB。
2. 创建 `HumanoidAnimator(model, profile)`。
3. 控制器只调用 `set(HUMANOID_ACTION.WALK)`、`RUN_JUMP`、`SWIM` 等语义动作。
4. 一次性攻击使用 `attack()`；结束后状态机会回到当前移动或空闲动作。
5. 新人形模型提供同样的语义 profile，即可复用玩家与 NPC 行为。
