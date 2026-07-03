import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { CallTodo } from './call-todo.schema';
import {
  CompleteCallTodoDto,
  CreateCallTodoDto,
  ListCallTodosQueryDto,
  SnoozeCallTodoDto,
  UpdateCallTodoDto,
} from './call-todo.dto';

@Injectable()
export class CallTodoService {
  constructor(
    @InjectModel(CallTodo.name) private readonly model: Model<CallTodo>,
  ) {}

  async create(
    workspaceId: string,
    firmId: string,
    dto: CreateCallTodoDto,
    createdBy?: string,
  ): Promise<CallTodo> {
    return new this.model({
      workspaceId: new Types.ObjectId(workspaceId),
      firmId: new Types.ObjectId(firmId),
      partyId: new Types.ObjectId(dto.partyId),
      invoiceId: dto.invoiceId ? new Types.ObjectId(dto.invoiceId) : undefined,
      invoiceIds: dto.invoiceIds?.map((id) => new Types.ObjectId(id)),
      title: dto.title,
      notes: dto.notes,
      contactPhone: dto.contactPhone,
      contactName: dto.contactName,
      totalOverdueAmountPaise: dto.totalOverdueAmountPaise,
      callType: dto.callType ?? 'payment_followup',
      priority: dto.priority ?? 'medium',
      dueDate: dto.dueDate ? new Date(dto.dueDate) : undefined,
      assignedTo: new Types.ObjectId(dto.assignedTo),
      createdBy: createdBy ? new Types.ObjectId(createdBy) : undefined,
    }).save();
  }

  async list(
    workspaceId: string,
    firmId: string,
    query: ListCallTodosQueryDto,
  ): Promise<CallTodo[]> {
    const filter: Record<string, any> = {
      workspaceId: new Types.ObjectId(workspaceId),
      firmId: new Types.ObjectId(firmId),
    };
    if (query.status !== undefined) filter.status = query.status;
    if (query.assignedTo !== undefined) filter.assignedTo = new Types.ObjectId(query.assignedTo);
    if (query.partyId !== undefined) filter.partyId = new Types.ObjectId(query.partyId);
    if (query.priority !== undefined) filter.priority = query.priority;
    return this.model.find(filter).sort({ createdAt: -1 }).exec();
  }

  async get(workspaceId: string, firmId: string, id: string): Promise<CallTodo> {
    const todo = await this.model.findOne({
      _id: new Types.ObjectId(id),
      workspaceId: new Types.ObjectId(workspaceId),
      firmId: new Types.ObjectId(firmId),
    }).exec();
    if (!todo) throw new NotFoundException(`CallTodo ${id} not found`);
    return todo;
  }

  async update(
    workspaceId: string,
    firmId: string,
    id: string,
    dto: UpdateCallTodoDto,
  ): Promise<CallTodo> {
    const updatePayload: Record<string, any> = { ...dto };
    if (dto.assignedTo) updatePayload.assignedTo = new Types.ObjectId(dto.assignedTo);
    if (dto.dueDate) updatePayload.dueDate = new Date(dto.dueDate);
    const updated = await this.model.findOneAndUpdate(
      {
        _id: new Types.ObjectId(id),
        workspaceId: new Types.ObjectId(workspaceId),
        firmId: new Types.ObjectId(firmId),
      },
      { $set: updatePayload },
      { new: true },
    ).exec();
    if (!updated) throw new NotFoundException(`CallTodo ${id} not found`);
    return updated;
  }

  async snooze(
    workspaceId: string,
    firmId: string,
    id: string,
    dto: SnoozeCallTodoDto,
  ): Promise<CallTodo> {
    const todo = await this.get(workspaceId, firmId, id);
    const currentDue = todo.dueDate ?? new Date();
    const newDue = new Date(currentDue.getTime() + dto.days * 86_400_000);
    const updated = await this.model.findOneAndUpdate(
      {
        _id: new Types.ObjectId(id),
        workspaceId: new Types.ObjectId(workspaceId),
        firmId: new Types.ObjectId(firmId),
      },
      {
        $set: { status: 'snoozed', dueDate: newDue },
        $inc: { snoozeDays: dto.days },
      },
      { new: true },
    ).exec();
    if (!updated) throw new NotFoundException(`CallTodo ${id} not found`);
    return updated;
  }

  async complete(
    workspaceId: string,
    firmId: string,
    id: string,
    userId: string,
    dto: CompleteCallTodoDto,
  ): Promise<CallTodo> {
    const updated = await this.model.findOneAndUpdate(
      {
        _id: new Types.ObjectId(id),
        workspaceId: new Types.ObjectId(workspaceId),
        firmId: new Types.ObjectId(firmId),
      },
      {
        $set: {
          status: 'done',
          completedAt: new Date(),
          completedBy: new Types.ObjectId(userId),
          completionNote: dto.completionNote,
        },
      },
      { new: true },
    ).exec();
    if (!updated) throw new NotFoundException(`CallTodo ${id} not found`);
    return updated;
  }

  async softDelete(workspaceId: string, firmId: string, id: string): Promise<void> {
    const updated = await this.model.findOneAndUpdate(
      {
        _id: new Types.ObjectId(id),
        workspaceId: new Types.ObjectId(workspaceId),
        firmId: new Types.ObjectId(firmId),
      },
      { $set: { status: 'cancelled' } },
      { new: true },
    ).exec();
    if (!updated) throw new NotFoundException(`CallTodo ${id} not found`);
  }

  async countPending(
    workspaceId: string,
    firmId: string,
    userId: string,
  ): Promise<{ pendingCount: number; urgentCount: number }> {
    const [pendingCount, urgentCount] = await Promise.all([
      this.model.countDocuments({
        workspaceId: new Types.ObjectId(workspaceId),
        firmId: new Types.ObjectId(firmId),
        assignedTo: new Types.ObjectId(userId),
        status: 'pending',
      }),
      this.model.countDocuments({
        workspaceId: new Types.ObjectId(workspaceId),
        firmId: new Types.ObjectId(firmId),
        assignedTo: new Types.ObjectId(userId),
        status: 'pending',
        priority: 'urgent',
      }),
    ]);
    return { pendingCount, urgentCount };
  }

  /**
   * Find the first pending CallTodo for a party — used by dispatcher for escalation-level-3 dedup.
   */
  async findPendingForParty(
    workspaceId: string,
    firmId: string,
    partyId: string,
  ): Promise<CallTodo | null> {
    return this.model.findOne({
      workspaceId: new Types.ObjectId(workspaceId),
      firmId: new Types.ObjectId(firmId),
      partyId: new Types.ObjectId(partyId),
      status: 'pending',
    }).exec();
  }
}
