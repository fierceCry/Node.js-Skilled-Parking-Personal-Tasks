import express from 'express';
import { prisma } from '../utils/prisma.util.js';
import { authMiddleware } from '../middlewarmies/require-access-token.middleware.js';
import { catchAsync } from '../middlewarmies/error-handler.middleware.js';
import { resumerCreatesSchema } from '../middlewarmies/validation/resumeCreate.validation.middleware.js';
import { resumerLogSchema } from '../middlewarmies/validation/resumeLogCreate.validation.middleware.js';
import { resumerUpdateSchema } from '../middlewarmies/validation/resumeUpdate.validation.middleware.js';
import { RESUME_MESSAGES } from '../constants/resume.constant.js';
import { requireRoles } from '../middlewarmies/require-roles.middleware.js';

const resumesRouter = express.Router();

/** 이력서 생성 API **/
resumesRouter.post('/', authMiddleware, resumerCreatesSchema, catchAsync(async (req, res) => {
  const { id } = req.user;
  const resumerData = req.body;
  // 이력서 생성
  const result = await prisma.resume.create({
    data: {
      userId: id,
      title: resumerData.title,
      content: resumerData.content,
    },
  });
  return res.status(200).json({ data: result });
}));

/** 이력서 목록 조회 API **/
resumesRouter.get('/', authMiddleware, catchAsync(async (req, res) => {
  const { id, role } = req.user;
  let { sortBy = 'createdAt', order = 'desc', status } = req.query;

  // 기본적으로 'desc'로 설정
  order = order === 'asc' ? 'asc' : 'desc';

  // whereClause 설정
  const whereClause = role === 'RECRUITER' ? {} : { userId: id };
  if (status) {
    whereClause.applyStatus = status;
  }

  const data = await prisma.resume.findMany({
    where: whereClause,
    orderBy: {
      [sortBy]: order,
    },
    select: {
      id: true,
      user: { select: { nickname: true } },
      title: true,
      content: true,
      applyStatus: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  const transformedData = data.map(item => ({
    id: item.id,
    nickname: item.user.nickname,
    title: item.title,
    content: item.content,
    applyStatus: item.applyStatus,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  }));

  return res.status(200).json({ data: transformedData });
}));

/** 이력서 상세 조회 API **/
resumesRouter.get('/:resumeId', authMiddleware, catchAsync(async (req, res) => {
  const { id, role } = req.user;
  const { resumeId } = req.params;

  // 이력서가 존재하는지 확인
  const result = await prisma.resume.findFirst({
    where: { id: +resumeId }
  });

  if (!result) {
    return res.status(404).json({ message: RESUME_MESSAGES.RESUME_NOT_FOUND });
  }
  if (role === 'APPLICANT' && result.userId !== id) {
    return res.status(403).json({ message: RESUME_MESSAGES.ACCESS_DENIED });
  }

  // 이력서 조회
  const data = await prisma.resume.findMany({
    where: { id: parseInt(resumeId) },
    include: {
      user: {
        select: {
          nickname: true
        }
      }
    }
  });
  const transformedData = data.map(item => ({
    id: item.id,
    nickname: item.user.nickname,
    title: item.title,
    content: item.content,
    applyStatus: item.applyStatus,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  }));
  return res.status(200).json({ data: transformedData });
}));

/** 이력서 수정 API **/
resumesRouter.patch('/:resumeId', authMiddleware, resumerUpdateSchema, catchAsync(async(req, res)=>{
  const data = req.body;
  const { id } = req.user;
  const { resumeId } = Number(req.params);
  // 이력서 존재 여부 확인
  const existingResume = await prisma.resume.findFirst({
    where: {
        id: resumeId,
        userId: id
      }
  });
  if (!existingResume) {
    return res.status(404).json({ error: RESUME_MESSAGES.RESUME_NOT_FOUND });
  }
  // 데이터 업데이트
  const updatedResume = await prisma.resume.update({
    where: {
      id: existingResume.id,
      userId: id
    },
    data: {
      ...(data.title && { title: data.title }),
      ...(data.content && { content: data.content })
    }
  });
  return res.status(200).json({ data: updatedResume });
}));

/** 이력서 삭제 API **/
resumesRouter.delete('/:resumeId', authMiddleware, catchAsync(async(req, res)=>{
  const { id } = req.user;
  const { deleteId } = req.params;

  const data = await prisma.resume.findFirst({
    where: {
      id: parseInt(deleteId),
      userId : id
    }
  })

  const logData = await prisma.resumeLog.findFirst({
    where: {
      resumeId: parseInt(deleteId)
    }
  })
  if(logData){
    return res.status(400).json({ message : RESUME_MESSAGES.RECRUITER_RESULT_PUBLISHED_DELETE_DENIED})
  }

  if(!data) return res.status(400).json({ message: RESUME_MESSAGES.RESUME_NOT_FOUND})

    const deletedResume = await prisma.resume.delete({
      where: {
        id: parseInt(deleteId)
      }
    });

  
  return res.status(200).json({ data: deletedResume.id})
}));

/** 이력서 지원자 이력서 수정 & 로그 생성 API **/
resumesRouter.patch('/:resumeId/logs', authMiddleware, resumerLogSchema, requireRoles(['RECRUITER']), catchAsync(async (req, res) => {
  const userId = req.user.id;
  const data = req.body;
  const { resumeId } = req.params;

  // 이력서를 찾습니다.
  const resume = await prisma.resume.findUnique({
    where: { id: parseInt(resumeId) },
  });
  if (!resume) {
    return res.status(404).json({ message: '이력서가 존재하지 않습니다.' });
  }
  const result = await prisma.$transaction(async (tx) => { // prisma 대신 tx를 사용
    // 이력서 정보 업데이트
    await tx.resume.update({
      where: { id: parseInt(resumeId) },
      data: { applyStatus: data.resumeStatus },
    });

    // 채용 담당자 정보 조회
    const recruiter = await tx.user.findUnique({
      where: { id: userId },
    });
    // 이력서 로그 생성
    const resumeLog = await tx.resumeLog.create({
      data: {
        resume: { connect: { id: parseInt(resumeId) } },
        recruiter: { connect: { id: recruiter.id } },
        oldApplyStatus: resume.applyStatus,
        newApplyStatus: data.resumeStatus,
        reason: data.reason,
      },
    });

    return resumeLog;
  });

  // 변경된 로그를 반환합니다.
  return res.status(200).json({ data: result });
}));

/** 이력서 로그 상세 조회 API **/
resumesRouter.get('/:resumeId/status', authMiddleware, requireRoles(['RECRUITER']), catchAsync(async (req, res) => {
  const { resumeId } = req.params;
  const data = await prisma.resumeLog.findMany({
    orderBy: {
      createdAt: 'desc',
    },
    where: {
      resumeId: parseInt(resumeId) // 이력서 ID로 필터링
    },
    select: {
      id: true, 
      resumeId: true, 
      oldApplyStatus: true,
      newApplyStatus: true,
      reason: true,
      createdAt: true,
      recruiter: {
        select: {
          nickname: true
        }
      }
    }
  });
  const transformedData = data.map(item => ({
    id: item.id,
    nickname: item.recruiter.nickname,
    oldApplyStatus: item.oldApplyStatus,
    newApplyStatus: item.newApplyStatus,
    createdAt: item.createdAt,
  }));
  // 조회한 이력서 로그 정보를 반환
  return res.status(200).json({ data: transformedData });
}));

export default resumesRouter;
