import { z } from "zod";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma";
import { FastifyInstance } from "fastify";
import { redis } from "../../lib/redis";
import { voting } from "../../utils/voting-pub-sub";

export async function voteOnPoll(app: FastifyInstance) {
  app.post("/polls/:pollId/votes", async (req, reply) => {
    const voteOnPollBody = z.object({
      pollOptionId: z.string().uuid(),
    });

    const voteOnPollParams = z.object({
      pollId: z.string().uuid(),
    });

    const { pollId } = voteOnPollParams.parse(req.params);
    const { pollOptionId } = voteOnPollBody.parse(req.body);

    let { sessionId } = req.cookies;

    const sessionExists = await prisma.vote.findFirst({
      where: {
        sessionId: sessionId,
      },
    });

    if (!sessionId || !sessionExists) {
      sessionId = randomUUID();

      if (sessionExists) {
        await prisma.vote.deleteMany({
          where: {
            sessionId: sessionExists.sessionId,
          },
        });

        const prevVotes = await redis.zrange(pollId, 0, -1);
        for (const option of prevVotes) {
          await redis.zrem(pollId, option);
        }
      }

      reply.setCookie("sessionId", sessionId, {
        path: "/",
        maxAge: 60 * 60 * 24 * 30,
        httpOnly: true,
        sameSite: "strict",
      });
    }

    const userPreviousVoteOnPoll = await prisma.vote.findUnique({
      where: {
        sessionId_pollId: {
          sessionId,
          pollId,
        },
      },
    });

    if (
      userPreviousVoteOnPoll &&
      userPreviousVoteOnPoll.pollOptionId !== pollOptionId
    ) {
      await prisma.vote.delete({
        where: {
          id: userPreviousVoteOnPoll.id,
        },
      });

      const votes = await redis.zincrby(
        pollId,
        -1,
        userPreviousVoteOnPoll.pollOptionId
      );

      voting.publish(pollId, {
        pollOptionId: userPreviousVoteOnPoll.pollOptionId,
        votes: Number(votes),
      });
    } else if (userPreviousVoteOnPoll) {
      return reply
        .status(400)
        .send({ message: "You already voted on this poll" });
    }

    await prisma.vote.create({
      data: {
        sessionId,
        pollId,
        pollOptionId,
      },
    });

    const votes = await redis.zincrby(pollId, 1, pollOptionId);

    voting.publish(pollId, {
      pollOptionId,
      votes: Number(votes),
    });

    return reply.status(201).send();
  });
}
