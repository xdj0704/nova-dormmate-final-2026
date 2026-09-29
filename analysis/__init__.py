"""DormMate 分析层（M2 起）。

rules.py           —— 规则入口（转发项目根的 status_rules，不重抄）
analysis.py        —— 读取导出的 CSV 并做基础统计、画趋势图、出 HTML 报告
report.py          —— 把 summary 渲染成 Markdown
make_sim_data.py   —— 生成「模拟日数据」data/day_sim.csv（Step 8-2）
daily_summary.py   —— 按节点找连续异常段，串成「今日摘要」（Step 8-2）

依赖方向是单向的：
    analysis.py ──> daily_summary.py ──> rules.py
daily_summary 反过来只在函数里延迟 import analysis（理由见它自己的文件头），
不然两边谁也先进不来。
"""
