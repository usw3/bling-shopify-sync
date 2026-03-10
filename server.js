import express from "express";

const app = express();
const port = process.env.PORT;

app.get("/", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

app.get("/bling/oauth", (req, res) => {
  console.log("GET /bling/oauth recebido", req.query);
  res.status(200).send("OK OAUTH");
});

app.listen(port, "0.0.0.0", () => {
  console.log(`Server running on port= ${port}`);
});
