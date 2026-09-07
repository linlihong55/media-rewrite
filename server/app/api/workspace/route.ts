import { NextRequest } from "next/server";
import { dashboardData, promoteCandidate } from "@/lib/workspace";
export async function GET() { try { return Response.json({ data:await dashboardData() }); } catch(e) { return Response.json({ error:e instanceof Error?e.message:"加载失败" },{status:503}); } }
export async function POST(req:NextRequest) { try { const b=await req.json(); if(!Number.isInteger(b.candidateId)) return Response.json({error:"candidateId 无效"},{status:400}); return Response.json({data:await promoteCandidate(b.candidateId)}); } catch(e) { return Response.json({error:e instanceof Error?e.message:"操作失败"},{status:400}); } }
