import { AllezORM } from "../allez-orm.mjs";
import UsersSchema from "../schemas/users.schema.js";
import PostsSchema from "../schemas/posts.schema.js";

const logEl = document.getElementById("log");
const details = document.getElementById("details");
const logs = [];
const say = (m, ok=true) => {
  const d=document.createElement("div");
  d.className=ok?"ok":"fail"; d.textContent=(ok?"✔ ":"✖ ")+m; details.appendChild(d); logs.push({ok,m});
};
const code = (title, obj) => {
  const pre=document.createElement("pre");
  pre.textContent=typeof obj==="string"?obj:JSON.stringify(obj,null,2);
  const wrap=document.createElement("div");
  wrap.innerHTML=`<div class="muted" style="margin-top:8px">${title}</div>`;
  wrap.appendChild(pre); details.appendChild(wrap);
};

(async () => {
  try {
    const dbName = "allez-test.db";
    const orm = await AllezORM.init({ dbName, schemas: [UsersSchema, PostsSchema] });
    const users = orm.table("users");
    const posts = orm.table("posts");
    const now = () => new Date().toISOString();

    await users.upsert({ id:"u1", email:"x@example.com", display_name:"X", role:"member", created_at:now(), updated_at:now() });
    const u1 = await users.findById("u1");
    say("users.upsert + findById", !!u1 && u1.email==="x@example.com");

    await posts.insert({ id:"p1", title:"hello", user_id:"u1", created_at:now(), updated_at:now() });
    say("posts.insert with valid FK", true);

    let threw=false;
    try { await posts.insert({ id:"p2", title:"bad", user_id:"nope", created_at:now(), updated_at:now() }); } catch { threw=true; }
    say("FK violation throws", threw);

    const res = await users.searchLike("x@", ["email"]);
    say("users.searchLike finds row", res.length>=1);

    await users.deleteSoft("u1");
    const u1b = await orm.get("SELECT deleted_at FROM users WHERE id=?", ["u1"]);
    say("users.deleteSoft sets deleted_at", !!u1b?.deleted_at);

    await orm.saveNow();
    const orm2 = await AllezORM.init({ dbName, schemas:[UsersSchema, PostsSchema] });
    const again = await orm2.table("users").findById("u1");
    say("IndexedDB persistence survives re-init", !!again);

    const ok = logs.every(x=>x.ok);
    logEl.textContent = ok ? "All runtime tests passed." : "Some runtime tests failed.";
    if (!ok) code("Details", logs);
  } catch (e) {
    logEl.textContent = "Runtime tests crashed.";
    say(String(e), false);
  }
})();
