Nukadoko.config(
  envFiles: ["shared.env", "gone.env"],
  secrets: { public: ["NOPE"], redact: ["API_TOKEN", "MISSING"] },
)
