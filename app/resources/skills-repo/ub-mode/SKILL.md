---
name: ub-mode
description: >
  写代码或改代码时遵循精简工程准则。每次改动都按「先跑通（First Make it
  Work）→ 再做对（Then Make it Right）→ 按实践收尾（Practice）」三段执行。
  当用户点名 ub-mode 或要求按精简原则干活时使用。
---

# ub-mode

每次被要求做改动，都按以下顺序执行：

* 先跑通（First Make it Work）。
* 再做对（Then Make it Right）。
* 按实践收尾（Practice）。

# 先跑通（First Make it Work）

## 懒惰协议（Laziness Protocol）

* 一个决策只放在一个地方。
* 交付能解决问题的最小改动。

## 打地基的思考（Foundational Thinking）

* 先把数据形状定对，再写逻辑。
* 先做对所有后续阶段都有帮助的事。
* 如果并发写者会有影响，就不要共享状态。

## TDD

* 改代码之前，先写一个会失败的测试。
* 亲眼看它以你预期的原因失败。
* 用最小的改动让它通过。
* 如果写不出诚实的测试，就不要写个坏测试凑数。

## 从第一性原理重新设计（Redesign From First Principles）

* 不要把新需求硬拧到旧设计上。
* 问自己「如果一开始就有这个需求，我会怎么建」，把那个设计想透，再分块交付。

## 攻击前提（Attack the Premise）

* 当共享同一个前提的两种修法在同一个关卡上双双失败时，用一句话写下这个前提，数一数哪些角色握着失衡的那一头。
* 把那个失衡的指派去掉。
* 在做到这一点之前，不要开始下一种修法。

## 先减后加（Subtract Before You Add）

* 加任何东西之前，先把复杂度减出去。

## 面向结果的执行（Outcome-Oriented Execution）

* 瞄准一个你能检验的终态。
* 中途暂停是允许的，前提是你事先计划过、并且能撤销。

## 造杠杆（Build the Lever）

* 如果这活儿一眼看不出怎么做，就先造一个干这活的工具。
* 先手工做一个单元，再让工具照着这个单元做。

## 架构（Architecture）

### 为领域建模（Model the Domain）

* 把领域放进一个让非法状态无法表示的结构里。
* 维护一份领域术语表。
* 如果代码已经清晰且局部自洽，就别动它。

### 边界纪律（Boundary Discipline）

* 在数据进入的地方检查它。
* 进来之后，信任它。
* 把业务逻辑放进纯函数。

### 类型系统纪律（Type System Discipline）

* 让非法值根本写不出来。
* 外部数据在入口处只解析一次。
* 不要让编译器闭嘴。

### 让操作幂等（Make Operations Idempotent）

* 跑两遍，或者中途崩溃之后再跑，结束时的状态都一样。

### 共享状态先分离再串行化（Separate Before Serializing Shared State）

* 如果它们不需要同一份可变的东西，就各给各的。
* 如果确实需要，就只允许一个写者，并用结构强制这一点。

# 再做对（Then Make it Right）

## 修根因（Fix Root Causes）

* 先复现。
* 修原因。
* 只是把崩溃藏起来的护栏不算修复。

## 把工作切成可验证的小单元（Sequence work into verifiable units）

* 做完一个小单元就验证一个。
* 然后再开始下一个。

## 测行为，不测实现（Test Behavior, Not Implementation）

* 测试要按使用者调用代码的方式去调用，并检查使用者会看到的结果。
* 如果把每个函数都改成返回空、测试还能过，这个测试就该扔掉。

## Crapper

* 用 crapper 工具
* 通过拆分函数、补测试，或两者并用，把每个函数的 CRAP 压到 10 以下。
* 想一想那些 case 分支值不值得压。

## Dryer

* 用 dryer 工具消除相似度 0.8 以上的重复。

## Mutator

* 用 mutator 工具
* 把没被覆盖的覆盖掉。
* 杀掉存活的变异体。
* 删掉死代码。

## 重构（Refactoring）

* 先钉住代码现在的行为。
* 再改结构。
* 证明行为没有变。

# 按实践收尾（Practice）

## 记日志（Keep a Log）

* 记下你做的每个动作，以及做它的原因。
* 完成时把日志汇报出来。

## 守住上下文窗口（Guard the Context Window）

* 主线程保持精简。
* 把大块头挪到别处，只留摘要。

## 清理工作树（Worktree Cleanup）

* 找出可以安全删除的东西，确认没有仍在使用的东西需要它，再回收磁盘。
* 未提交的工作等人拍板，不要擅自处理。

## 提交与推送（Commit and Push）

* 勤提交，小而有序。
* 每个提交都说清楚：为什么改、改了什么、怎么证明的。
* 最后推到主线。
