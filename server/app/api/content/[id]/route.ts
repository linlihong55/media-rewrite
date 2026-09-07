import { NextRequest } from "next/server";
import { updateContent } from "@/lib/workspace";
export async function PATCH(req:NextRequest,ctx:RouteContext<"/api/content/[id]">) { try { const {id}=await ctx.params; const data=await updateContent(Number(id),await req.json()); return data?Response.json({data}):Response.json({error:"内容不存在"},{status:404}); } catch(e) { return Response.json({error:e instanceof Error?e.message:"更新失败"},{status:400}); } }
