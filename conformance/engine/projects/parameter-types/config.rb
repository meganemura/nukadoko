Nukadoko.config(
  parameterTypes: [
    { name: "priority", regexp: /高|低/, transformer: ->(s) { s == "高" ? "high" : "low" } },
    { name: "dueDay", regexp: /今日|明日/ },
  ],
)
