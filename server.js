import express from "express";

const app = express();
const port = process.env.PORT || 3000;

app.get("/", (_req, res) => {
  console.log("GET / recebido");
  res.status(200).send("OK ROOT");
});

app.get("/bling/oauth", (req, res) => {
  console.log("GET /bling/oauth recebido", req.query);
  res.status(200).send("OK OAUTH");
});

app.listen(port, "0.0.0.0", () => {
  console.log(`Server running on port ${port}`);
});