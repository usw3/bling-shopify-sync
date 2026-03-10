import express from "express";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

app.get("/", (req,res)=>{
  res.send("Middleware Bling → Shopify funcionando");
});

app.post("/webhooks/bling/products",(req,res)=>{
  console.log(req.body);
  res.json({ok:true});
});

const port = process.env.PORT || 3000;

app.listen(port,()=>{
  console.log("Server running on port",port);
});